// Package web embeds the website (/) and the chat app (/app/) and serves
// them with strict security headers. The app makes no third-party requests.
package web

import (
	"bytes"
	"compress/gzip"
	"embed"
	"io/fs"
	"net/http"
	"strings"
	"sync"
)

//go:embed all:site all:app
var files embed.FS

const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; " +
	"style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; " +
	"object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

func secure(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), geolocation=(), microphone=(self), interest-cohort=()")
		if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		// The app must always be fresh so updates cannot be pinned by a cache.
		h.Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}

var (
	gzOnce sync.Once
	gzWasm []byte
)

// wasmGzip serves the 4 MB crypto module compressed (~1 MB).
func wasmGzip(next http.Handler, root fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/app/nullraum.wasm" || !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		gzOnce.Do(func() {
			raw, err := fs.ReadFile(root, "app/nullraum.wasm")
			if err != nil {
				return
			}
			var buf bytes.Buffer
			zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
			zw.Write(raw)
			zw.Close()
			gzWasm = buf.Bytes()
		})
		if gzWasm == nil {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/wasm")
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Vary", "Accept-Encoding")
		w.Write(gzWasm)
	})
}

// Handler serves the website at / and the app at /app/. ws is mounted at /ws.
func Handler(ws http.Handler, extra map[string]http.Handler) http.Handler {
	mux := http.NewServeMux()
	site, _ := fs.Sub(files, "site")
	mux.Handle("/app/", http.FileServerFS(files))
	mux.Handle("/", http.FileServerFS(site))
	mux.Handle("/ws", ws)
	for p, h := range extra {
		mux.Handle(p, h)
	}
	return secure(wasmGzip(mux, files))
}
