// Package relay implements the Nullraum relay: a blind WebSocket switch.
//
// The relay never sees plaintext, room codes, names or keys. It only knows
// opaque 256-bit room IDs (a hash derived from the room code) and forwards
// encrypted frames between the connections in a room. Nothing is written to
// disk and no IP addresses are logged. Encrypted frames marked "store" are
// kept in RAM for a limited time so offline members can catch up.
package relay

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"crypto/rand"

	"github.com/coder/websocket"
)

type Config struct {
	MaxRooms        int
	MaxPeersPerRoom int
	MaxConnsPerIP   int
	MaxFrameBytes   int64
	MailboxTTL      time.Duration // 0 disables the store-and-forward mailbox
	MailboxMaxBytes int           // per room
	MailboxMaxItems int           // per room
	MailboxTotal    int           // bytes across all rooms
	FramesPerSecond float64
	FrameBurst      int
	TrustProxy      bool // take the client IP from X-Forwarded-For (only for connection limits)
}

func DefaultConfig() Config {
	return Config{
		MaxRooms:        10000,
		MaxPeersPerRoom: 64,
		MaxConnsPerIP:   32,
		MaxFrameBytes:   1 << 20,
		MailboxTTL:      72 * time.Hour,
		MailboxMaxBytes: 256 << 20,
		MailboxMaxItems: 20000,
		MailboxTotal:    1 << 30,
		FramesPerSecond: 60,
		FrameBurst:      240,
	}
}

type Hub struct {
	cfg   Config
	mu    sync.Mutex
	rooms map[string]*room
	ips   map[string]int
	mbAll int // bytes in all mailboxes
}

type room struct {
	peers   map[string]*peer
	mailbox []stored
	mbBytes int
}

type stored struct {
	at   time.Time
	data []byte // complete "recv" frame
}

type peer struct {
	id   string
	room string
	out  chan []byte
	kill context.CancelFunc
}

func NewHub(cfg Config) *Hub {
	return &Hub{cfg: cfg, rooms: map[string]*room{}, ips: map[string]int{}}
}

// Run purges expired mailbox entries until ctx is cancelled.
func (h *Hub) Run(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.purge()
		}
	}
}

func (h *Hub) purge() {
	h.mu.Lock()
	defer h.mu.Unlock()
	cutoff := time.Now().Add(-h.cfg.MailboxTTL)
	for id, r := range h.rooms {
		i := 0
		for i < len(r.mailbox) && r.mailbox[i].at.Before(cutoff) {
			r.mbBytes -= len(r.mailbox[i].data)
			h.mbAll -= len(r.mailbox[i].data)
			i++
		}
		r.mailbox = r.mailbox[i:]
		if len(r.peers) == 0 && len(r.mailbox) == 0 {
			delete(h.rooms, id)
		}
	}
}

// Stats is safe to expose: it reveals only aggregate counts.
func (h *Hub) Stats() (rooms, peers int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range h.rooms {
		peers += len(r.peers)
	}
	return len(h.rooms), peers
}

type inFrame struct {
	T     string          `json:"t"`
	Room  string          `json:"room,omitempty"`
	To    string          `json:"to,omitempty"`
	Store bool            `json:"store,omitempty"`
	D     json.RawMessage `json:"d,omitempty"`
}

type outFrame struct {
	T     string          `json:"t"`
	Peer  string          `json:"peer,omitempty"`
	Peers []string        `json:"peers,omitempty"`
	From  string          `json:"from,omitempty"`
	MB    bool            `json:"mb,omitempty"`
	D     json.RawMessage `json:"d,omitempty"`
	Err   string          `json:"error,omitempty"`
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func newPeerID() string { return hex.EncodeToString(randBytes(8)) }

func randBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

func validRoomID(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil && strings.ToLower(s) == s
}

func (h *Hub) clientIP(r *http.Request) string {
	if h.cfg.TrustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			return strings.TrimSpace(strings.Split(xff, ",")[0])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ServeHTTP upgrades to a WebSocket and runs the relay protocol:
//
//	client → {"t":"join","room":"<64 hex>"}
//	relay  → {"t":"hello","peer":"<id>","peers":[...]}
//	client → {"t":"send","to":"<peer, optional>","store":bool,"d":{...}}
//	relay  → {"t":"recv","from":"<peer>","d":{...}}   (to everyone else, or just "to")
//	relay  → {"t":"peer_join"|"peer_leave","peer":"<id>"}
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ip := h.clientIP(r)
	h.mu.Lock()
	if h.ips[ip] >= h.cfg.MaxConnsPerIP {
		h.mu.Unlock()
		http.Error(w, "too many connections", http.StatusTooManyRequests)
		return
	}
	h.ips[ip]++
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		if h.ips[ip]--; h.ips[ip] <= 0 {
			delete(h.ips, ip)
		}
		h.mu.Unlock()
	}()

	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(h.cfg.MaxFrameBytes)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	jctx, jcancel := context.WithTimeout(ctx, 15*time.Second)
	var first inFrame
	_, data, err := c.Read(jctx)
	jcancel()
	if err != nil || json.Unmarshal(data, &first) != nil || first.T != "join" || !validRoomID(first.Room) {
		c.Close(websocket.StatusPolicyViolation, "expected join")
		return
	}

	p := &peer{id: newPeerID(), room: first.Room, out: make(chan []byte, 512), kill: cancel}
	backlog, err := h.register(p)
	if err != nil {
		c.Close(websocket.StatusTryAgainLater, err.Error())
		return
	}
	defer h.unregister(p)

	go h.writeLoop(ctx, c, p)
	for _, b := range backlog {
		h.enqueue(p, b)
	}

	tokens := float64(h.cfg.FrameBurst)
	last := time.Now()
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		now := time.Now()
		tokens = min(float64(h.cfg.FrameBurst), tokens+now.Sub(last).Seconds()*h.cfg.FramesPerSecond)
		last = now
		if tokens < 1 {
			c.Close(websocket.StatusPolicyViolation, "rate limit")
			return
		}
		tokens--

		var f inFrame
		if json.Unmarshal(data, &f) != nil || f.T != "send" || len(f.D) == 0 || f.D[0] != '{' {
			continue
		}
		h.route(p, f)
	}
}

func (h *Hub) writeLoop(ctx context.Context, c *websocket.Conn, p *peer) {
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case b := <-p.out:
			wctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			err := c.Write(wctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				p.kill()
				return
			}
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, 20*time.Second)
			err := c.Ping(pctx)
			cancel()
			if err != nil {
				p.kill()
				return
			}
		}
	}
}

// enqueue never blocks; a peer that cannot keep up is disconnected.
func (h *Hub) enqueue(p *peer, b []byte) {
	select {
	case p.out <- b:
	default:
		p.kill()
	}
}

var (
	errFull    = errors.New("room full")
	errTooBusy = errors.New("relay full")
)

func (h *Hub) register(p *peer) ([][]byte, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[p.room]
	if r == nil {
		if len(h.rooms) >= h.cfg.MaxRooms {
			return nil, errTooBusy
		}
		r = &room{peers: map[string]*peer{}}
		h.rooms[p.room] = r
	}
	if len(r.peers) >= h.cfg.MaxPeersPerRoom {
		return nil, errFull
	}
	others := make([]string, 0, len(r.peers))
	join := mustJSON(outFrame{T: "peer_join", Peer: p.id})
	for id, o := range r.peers {
		others = append(others, id)
		h.enqueue(o, join)
	}
	r.peers[p.id] = p

	backlog := [][]byte{mustJSON(outFrame{T: "hello", Peer: p.id, Peers: others})}
	for _, s := range r.mailbox {
		backlog = append(backlog, s.data)
	}
	backlog = append(backlog, mustJSON(outFrame{T: "mailbox_end"}))
	return backlog, nil
}

func (h *Hub) unregister(p *peer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[p.room]
	if r == nil {
		return
	}
	delete(r.peers, p.id)
	leave := mustJSON(outFrame{T: "peer_leave", Peer: p.id})
	for _, o := range r.peers {
		h.enqueue(o, leave)
	}
	if len(r.peers) == 0 && len(r.mailbox) == 0 {
		delete(h.rooms, p.room)
	}
}

func (h *Hub) route(p *peer, f inFrame) {
	msg := mustJSON(outFrame{T: "recv", From: p.id, D: f.D})
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[p.room]
	if r == nil {
		return
	}
	if f.To != "" {
		if o := r.peers[f.To]; o != nil {
			h.enqueue(o, msg)
		}
		return
	}
	for id, o := range r.peers {
		if id != p.id {
			h.enqueue(o, msg)
		}
	}
	if f.Store && h.cfg.MailboxTTL > 0 {
		mb := mustJSON(outFrame{T: "recv", MB: true, D: f.D})
		if h.mbAll+len(mb) > h.cfg.MailboxTotal {
			return // relay-wide RAM budget exhausted; live delivery still works
		}
		r.mailbox = append(r.mailbox, stored{at: time.Now(), data: mb})
		r.mbBytes += len(mb)
		h.mbAll += len(mb)
		for len(r.mailbox) > 0 && (r.mbBytes > h.cfg.MailboxMaxBytes || len(r.mailbox) > h.cfg.MailboxMaxItems) {
			r.mbBytes -= len(r.mailbox[0].data)
			h.mbAll -= len(r.mailbox[0].data)
			r.mailbox = r.mailbox[1:]
		}
	}
}
