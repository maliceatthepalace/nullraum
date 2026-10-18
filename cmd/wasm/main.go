//go:build js && wasm

// Command wasm exposes internal/pqc to the browser. It is loaded inside a
// Web Worker (web/app/crypto-worker.js), so slow operations like Argon2id
// never block the UI. Every function returns either its result or an object
// {error: "..."}; byte values are Uint8Arrays.
package main

import (
	"fmt"
	"syscall/js"

	"github.com/maliceatthepalace/nullraum/internal/pqc"
)

func bytesIn(v js.Value) []byte {
	b := make([]byte, v.Get("length").Int())
	js.CopyBytesToGo(b, v)
	return b
}

func bytesOut(b []byte) js.Value {
	u := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(u, b)
	return u
}

func errOut(err error) js.Value {
	return js.ValueOf(map[string]any{"error": err.Error()})
}

func pair(a, b []byte, err error) any {
	if err != nil {
		return errOut(err)
	}
	return js.ValueOf(map[string]any{"priv": bytesOut(a), "pub": bytesOut(b)})
}

func one(b []byte, err error) any {
	if err != nil {
		return errOut(err)
	}
	return bytesOut(b)
}

func str(s string, err error) any {
	if err != nil {
		return errOut(err)
	}
	return s
}

type fn func(args []js.Value) any

func wrap(f fn) js.Func {
	return js.FuncOf(func(_ js.Value, args []js.Value) (res any) {
		defer func() {
			if r := recover(); r != nil {
				res = errOut(fmt.Errorf("%v", r))
			}
		}()
		return f(args)
	})
}

func main() {
	api := map[string]fn{
		"random":             func(a []js.Value) any { return bytesOut(pqc.Random(a[0].Int())) },
		"newRoomCode":        func(a []js.Value) any { return pqc.NewRoomCode() },
		"newSecondKey":       func(a []js.Value) any { return pqc.NewSecondKey() },
		"parseRoomCode":      func(a []js.Value) any { return str(pqc.ParseRoomCode(a[0].String())) },
		"normalizeSecondKey": func(a []js.Value) any { return str(pqc.NormalizeSecondKey(a[0].String())) },
		"normalizeAnswer":    func(a []js.Value) any { return pqc.NormalizeAnswer(a[0].String()) },
		"deriveMaster":       func(a []js.Value) any { return bytesOut(pqc.DeriveMaster(a[0].String())) },
		"deriveSecret":       func(a []js.Value) any { return bytesOut(pqc.DeriveSecret(a[0].String(), bytesIn(a[1]))) },
		"hkdf":               func(a []js.Value) any { return bytesOut(pqc.HKDF(bytesIn(a[0]), a[1].String(), a[2].Int())) },
		"seal":               func(a []js.Value) any { return one(pqc.Seal(bytesIn(a[0]), bytesIn(a[1]), bytesIn(a[2]))) },
		"open":               func(a []js.Value) any { return one(pqc.Open(bytesIn(a[0]), bytesIn(a[1]), bytesIn(a[2]))) },
		"kemGenerate":        func(a []js.Value) any { return pair(pqc.KEMGenerate()) },
		"kemSeal":            func(a []js.Value) any { return one(pqc.KEMSeal(bytesIn(a[0]), a[1].String(), bytesIn(a[2]))) },
		"kemOpen":            func(a []js.Value) any { return one(pqc.KEMOpen(bytesIn(a[0]), a[1].String(), bytesIn(a[2]))) },
		"sigGenerate":        func(a []js.Value) any { return pair(pqc.SigGenerate()) },
		"sign":               func(a []js.Value) any { return one(pqc.Sign(bytesIn(a[0]), bytesIn(a[1]), a[2].String())) },
		"verify":             func(a []js.Value) any { return pqc.Verify(bytesIn(a[0]), bytesIn(a[1]), bytesIn(a[2]), a[3].String()) },
		"sha256":             func(a []js.Value) any { return bytesOut(pqc.SHA256(bytesIn(a[0]))) },
		"fingerprint": func(a []js.Value) any {
			parts := make([][]byte, len(a))
			for i, v := range a {
				parts[i] = bytesIn(v)
			}
			return pqc.Fingerprint(parts...)
		},
	}
	obj := js.Global().Get("Object").New()
	for name, f := range api {
		obj.Set(name, wrap(f))
	}
	js.Global().Set("NullraumCrypto", obj)
	select {}
}
