// Command nullraum runs the Nullraum relay server, or a local client that
// serves the app from your own machine and talks to a remote relay.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"

	"github.com/maliceatthepalace/nullraum/internal/relay"
	"github.com/maliceatthepalace/nullraum/web"
)

var version = "dev"

const usage = `Nullraum – post-quantum verschlüsselter Raum-Chat

Benutzung:
  nullraum serve  [Optionen]   Relay-Server + Web-App starten (für Docker / Server)
  nullraum client [Optionen]   App lokal ausliefern und mit einem entfernten Relay verbinden
  nullraum version

Ohne Befehl startet "nullraum serve -addr 127.0.0.1:8080 -open".

"nullraum serve -h" bzw. "nullraum client -h" zeigt alle Optionen.
`

func main() {
	log.SetFlags(log.LstdFlags)
	args := os.Args[1:]
	if len(args) == 0 {
		args = []string{"serve", "-addr", "127.0.0.1:8080", "-open"}
	}
	switch args[0] {
	case "serve":
		serve(args[1:])
	case "client":
		client(args[1:])
	case "version", "-v", "--version":
		fmt.Println("nullraum", version)
	default:
		fmt.Print(usage)
		if args[0] != "-h" && args[0] != "--help" && args[0] != "help" {
			os.Exit(2)
		}
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func serve(args []string) {
	cfg := relay.DefaultConfig()
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", envOr("NULLRAUM_ADDR", ":8080"), "Listen-Adresse")
	cert := fs.String("tls-cert", os.Getenv("NULLRAUM_TLS_CERT"), "TLS-Zertifikat (PEM)")
	key := fs.String("tls-key", os.Getenv("NULLRAUM_TLS_KEY"), "TLS-Schlüssel (PEM)")
	selfSigned := fs.Bool("self-signed", false, "Selbstsigniertes TLS-Zertifikat erzeugen (für LAN; Sprachnachrichten brauchen HTTPS)")
	open := fs.Bool("open", false, "Browser öffnen")
	fs.DurationVar(&cfg.MailboxTTL, "mailbox-ttl", cfg.MailboxTTL, "Wie lange verschlüsselte Nachrichten für Offline-Mitglieder im RAM bleiben (0 = aus)")
	mbMB := fs.Int("mailbox-room-mb", cfg.MailboxMaxBytes>>20, "RAM-Limit pro Raum in MB")
	mbAllMB := fs.Int("mailbox-total-mb", cfg.MailboxTotal>>20, "RAM-Limit für alle Räume in MB")
	fs.IntVar(&cfg.MaxPeersPerRoom, "max-peers", cfg.MaxPeersPerRoom, "Maximale Verbindungen pro Raum")
	fs.IntVar(&cfg.MaxRooms, "max-rooms", cfg.MaxRooms, "Maximale Anzahl gleichzeitiger Räume")
	fs.IntVar(&cfg.MaxConnsPerIP, "max-conns-per-ip", cfg.MaxConnsPerIP, "Maximale Verbindungen pro IP")
	fs.BoolVar(&cfg.TrustProxy, "trust-proxy", os.Getenv("NULLRAUM_TRUST_PROXY") == "1", "X-Forwarded-For vertrauen (nur hinter Reverse-Proxy)")
	fs.Parse(args)
	if v := os.Getenv("NULLRAUM_MAILBOX_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.MailboxTTL = d
		}
	}
	cfg.MailboxMaxBytes = *mbMB << 20
	cfg.MailboxTotal = *mbAllMB << 20

	hub := relay.NewHub(cfg)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go hub.Run(ctx)

	health := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rooms, peers := hub.Stats()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": version, "rooms": rooms, "peers": peers})
	})
	h := web.Handler(hub, map[string]http.Handler{"/healthz": health})

	srv := &http.Server{Addr: *addr, Handler: h, ReadHeaderTimeout: 10 * time.Second, ErrorLog: log.New(discard{}, "", 0)}
	scheme := "http"
	if *selfSigned {
		c, err := selfSignedCert()
		if err != nil {
			log.Fatal(err)
		}
		srv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{c}, MinVersion: tls.VersionTLS13}
		scheme = "https"
	} else if *cert != "" {
		scheme = "https"
	}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(sctx)
	}()

	log.Printf("Nullraum %s – Relay läuft auf %s://%s (keine Logs, keine Festplatte)", version, scheme, displayAddr(*addr))
	if *open {
		openBrowser(scheme + "://" + displayAddr(*addr) + "/app/")
	}
	var err error
	switch {
	case *selfSigned:
		err = srv.ListenAndServeTLS("", "")
	case *cert != "":
		err = srv.ListenAndServeTLS(*cert, *key)
	default:
		err = srv.ListenAndServe()
	}
	if err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// client serves the app from this machine, so the code that handles your
// keys comes from your own binary, not from the relay operator.
func client(args []string) {
	fs := flag.NewFlagSet("client", flag.ExitOnError)
	relayURL := fs.String("relay", envOr("NULLRAUM_RELAY", ""), "Relay-Adresse, z. B. https://chat.example.org")
	addr := fs.String("addr", "127.0.0.1:7777", "Lokale Adresse für die App")
	noBrowser := fs.Bool("no-browser", false, "Browser nicht automatisch öffnen")
	fs.Parse(args)
	if *relayURL == "" {
		fmt.Fprintln(os.Stderr, "Bitte -relay angeben, z. B.: nullraum client -relay https://chat.example.org")
		os.Exit(2)
	}
	u, err := url.Parse(*relayURL)
	if err != nil || u.Host == "" {
		log.Fatalf("Ungültige Relay-Adresse: %s", *relayURL)
	}
	switch u.Scheme {
	case "https", "wss":
		u.Scheme = "wss"
	case "http", "ws":
		u.Scheme = "ws"
		log.Printf("WARNUNG: Verbindung zum Relay ohne TLS. Inhalte bleiben Ende-zu-Ende verschlüsselt, Metadaten aber nicht.")
	default:
		log.Fatalf("Unbekanntes Schema %q", u.Scheme)
	}
	u.Path = strings.TrimSuffix(u.Path, "/") + "/ws"
	remote := u.String()

	proxy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		local, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer local.CloseNow()
		local.SetReadLimit(1 << 20)
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		up, _, err := websocket.Dial(ctx, remote, nil)
		if err != nil {
			local.Close(websocket.StatusTryAgainLater, "relay unreachable")
			return
		}
		defer up.CloseNow()
		up.SetReadLimit(4 << 20)
		go pipe(ctx, cancel, up, local)
		pipe(ctx, cancel, local, up)
	})
	srv := &http.Server{Addr: *addr, Handler: web.Handler(proxy, nil), ReadHeaderTimeout: 10 * time.Second}
	appURL := "http://" + displayAddr(*addr) + "/app/"
	log.Printf("Nullraum %s – lokale App: %s  →  Relay: %s", version, appURL, remote)
	if !*noBrowser {
		openBrowser(appURL)
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func pipe(ctx context.Context, cancel context.CancelFunc, dst, src *websocket.Conn) {
	defer cancel()
	for {
		t, b, err := src.Read(ctx)
		if err != nil {
			return
		}
		if err := dst.Write(ctx, t, b); err != nil {
			return
		}
	}
}

func displayAddr(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return "localhost" + addr
	}
	host, port, err := net.SplitHostPort(addr)
	if err == nil && (host == "0.0.0.0" || host == "::") {
		return "localhost:" + port
	}
	return addr
}

func openBrowser(u string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", u)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	default:
		cmd = exec.Command("xdg-open", u)
	}
	go func() {
		time.Sleep(400 * time.Millisecond)
		cmd.Run()
	}()
}

func selfSignedCert() (tls.Certificate, error) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "nullraum.local"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost", "nullraum.local"},
		IPAddresses:  localIPs(),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &k.PublicKey, k)
	if err != nil {
		return tls.Certificate{}, err
	}
	sum := fmt.Sprintf("%X", sha256.Sum256(der))
	log.Printf("Selbstsigniertes Zertifikat, SHA-256: %s", sum)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: k}, nil
}

func localIPs() []net.IP {
	ips := []net.IP{net.ParseIP("127.0.0.1")}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() {
			ips = append(ips, n.IP)
		}
	}
	return ips
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }
