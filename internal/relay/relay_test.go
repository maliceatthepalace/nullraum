package relay

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const roomA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type client struct {
	t  *testing.T
	c  *websocket.Conn
	id string
}

func dial(t *testing.T, url, roomID string) *client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(url, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	cl := &client{t: t, c: c}
	cl.send(map[string]any{"t": "join", "room": roomID})
	hello := cl.read()
	if hello.T != "hello" {
		t.Fatalf("expected hello, got %+v", hello)
	}
	cl.id = hello.Peer
	for cl.read().T != "mailbox_end" {
	}
	return cl
}

func (cl *client) send(v any) {
	b, _ := json.Marshal(v)
	if err := cl.c.Write(context.Background(), websocket.MessageText, b); err != nil {
		cl.t.Fatal(err)
	}
}

func (cl *client) read() outFrame {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, b, err := cl.c.Read(ctx)
	if err != nil {
		cl.t.Fatal(err)
	}
	var f outFrame
	json.Unmarshal(b, &f)
	return f
}

func (cl *client) readUntil(t string) outFrame {
	for {
		if f := cl.read(); f.T == t {
			return f
		}
	}
}

func TestRelayBroadcastTargetedAndMailbox(t *testing.T) {
	hub := NewHub(DefaultConfig())
	srv := httptest.NewServer(hub)
	defer srv.Close()

	a := dial(t, srv.URL, roomA)
	b := dial(t, srv.URL, roomA)
	if f := a.read(); f.T != "peer_join" || f.Peer != b.id {
		t.Fatalf("a expected peer_join, got %+v", f)
	}

	a.send(map[string]any{"t": "send", "store": true, "d": map[string]string{"c": "x1"}})
	if f := b.readUntil("recv"); f.From != a.id || string(f.D) != `{"c":"x1"}` {
		t.Fatalf("broadcast: %+v", f)
	}

	c := dial(t, srv.URL, roomA) // late joiner gets the stored frame
	_ = c
	a.send(map[string]any{"t": "send", "to": b.id, "d": map[string]string{"c": "only-b"}})
	if f := b.readUntil("recv"); string(f.D) != `{"c":"only-b"}` {
		t.Fatalf("targeted: %+v", f)
	}

	// The late joiner saw the mailbox frame during dial(); verify via a fresh one.
	d := dial2(t, srv.URL, roomA)
	if len(d) != 1 || string(d[0].D) != `{"c":"x1"}` || d[0].From != "" || !d[0].MB {
		t.Fatalf("mailbox replay: %+v", d)
	}

	other := dial(t, srv.URL, strings.Repeat("b", 64))
	a.send(map[string]any{"t": "send", "d": map[string]string{"c": "x2"}})
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, _, err := other.c.Read(ctx); err == nil {
		t.Fatal("frame leaked into another room")
	}
}

// dial2 joins and returns the mailbox frames delivered before mailbox_end.
func dial2(t *testing.T, url, roomID string) []outFrame {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(url, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	cl := &client{t: t, c: c}
	cl.send(map[string]any{"t": "join", "room": roomID})
	var out []outFrame
	for {
		f := cl.read()
		switch f.T {
		case "recv":
			out = append(out, f)
		case "mailbox_end":
			return out
		}
	}
}

func TestRelayRejectsBadJoin(t *testing.T) {
	srv := httptest.NewServer(NewHub(DefaultConfig()))
	defer srv.Close()
	c, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	c.Write(context.Background(), websocket.MessageText, []byte(`{"t":"join","room":"not-a-room"}`))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := c.Read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("expected policy violation, got %v", err)
	}
}

func TestRoomFull(t *testing.T) {
	cfg := DefaultConfig()
	cfg.MaxPeersPerRoom = 1
	srv := httptest.NewServer(NewHub(cfg))
	defer srv.Close()
	dial(t, srv.URL, roomA)
	c, _, _ := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	c.Write(context.Background(), websocket.MessageText, []byte(`{"t":"join","room":"`+roomA+`"}`))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := c.Read(ctx); websocket.CloseStatus(err) != websocket.StatusTryAgainLater {
		t.Fatalf("expected room full, got %v", err)
	}
}

func TestMailboxLargerThanSendQueue(t *testing.T) {
	const n = 2000 // well above the 512-frame send queue
	cfg := DefaultConfig()
	cfg.FrameBurst = n
	srv := httptest.NewServer(NewHub(cfg))
	defer srv.Close()
	a := dial(t, srv.URL, roomA)
	for i := 0; i < n; i++ {
		a.send(map[string]any{"t": "send", "store": true, "d": map[string]string{"c": "x"}})
	}
	time.Sleep(200 * time.Millisecond)
	if got := dial2(t, srv.URL, roomA); len(got) != n {
		t.Fatalf("mailbox replay: got %d of %d frames", len(got), n)
	}
}
