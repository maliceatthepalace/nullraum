package pqc

import (
	"bytes"
	"strings"
	"testing"
)

func TestRoomCodeRoundTrip(t *testing.T) {
	for range 50 {
		c := NewRoomCode()
		if len(c) != 39 || strings.Count(c, "-") != 7 {
			t.Fatalf("unexpected code format %q", c)
		}
		got, err := ParseRoomCode(strings.ToLower(strings.ReplaceAll(c, "-", " ")))
		if err != nil || got != c {
			t.Fatalf("ParseRoomCode(%q) = %q, %v", c, got, err)
		}
	}
}

func TestRoomCodeTypoDetected(t *testing.T) {
	c := NewRoomCode()
	b := []byte(c)
	if b[0] == 'A' {
		b[0] = 'B'
	} else {
		b[0] = 'A'
	}
	if _, err := ParseRoomCode(string(b)); err != ErrCodeChecksum {
		// a 10-bit checksum misses about 1 in 1024 typos
		t.Logf("typo not detected (expected rarely): %v", err)
	}
	if _, err := ParseRoomCode("ABCD"); err != ErrCodeLength {
		t.Fatalf("short code: got %v", err)
	}
	if _, err := ParseRoomCode(c[:5] + "!" + c[6:]); err != ErrCodeChar {
		t.Fatalf("bad char: got %v", err)
	}
}

func TestLookalikes(t *testing.T) {
	c := NewRoomCode()
	swapped := strings.NewReplacer("0", "O", "1", "l").Replace(c)
	got, err := ParseRoomCode(swapped)
	if err != nil || got != c {
		t.Fatalf("lookalikes: %q -> %q, %v", swapped, got, err)
	}
}

func TestSealOpen(t *testing.T) {
	key := Random(KeySize)
	for _, n := range []int{0, 1, 251, 252, 253, 5000, 70000} {
		pt := Random(n)
		ct, err := Seal(key, pt, []byte("aad"))
		if err != nil {
			t.Fatal(err)
		}
		got, err := Open(key, ct, []byte("aad"))
		if err != nil || !bytes.Equal(got, pt) {
			t.Fatalf("n=%d: round trip failed: %v", n, err)
		}
		if _, err := Open(key, ct, []byte("other")); err == nil {
			t.Fatal("wrong aad accepted")
		}
		ct[len(ct)-1] ^= 1
		if _, err := Open(key, ct, []byte("aad")); err == nil {
			t.Fatal("tampered ciphertext accepted")
		}
	}
}

func TestPaddingHidesLength(t *testing.T) {
	key := Random(KeySize)
	a, _ := Seal(key, []byte("ja"), nil)
	b, _ := Seal(key, []byte(strings.Repeat("x", 200)), nil)
	if len(a) != len(b) {
		t.Fatalf("short messages should have equal size: %d vs %d", len(a), len(b))
	}
}

func TestKEM(t *testing.T) {
	priv, pub, err := KEMGenerate()
	if err != nil {
		t.Fatal(err)
	}
	ct, err := KEMSeal(pub, "info", []byte("room key"))
	if err != nil {
		t.Fatal(err)
	}
	pt, err := KEMOpen(priv, "info", ct)
	if err != nil || string(pt) != "room key" {
		t.Fatalf("KEM round trip: %q %v", pt, err)
	}
	if _, err := KEMOpen(priv, "other", ct); err == nil {
		t.Fatal("wrong info accepted")
	}
	other, _, _ := KEMGenerate()
	if _, err := KEMOpen(other, "info", ct); err == nil {
		t.Fatal("wrong key accepted")
	}
}

func TestSignatures(t *testing.T) {
	priv, pub, err := SigGenerate()
	if err != nil {
		t.Fatal(err)
	}
	sig, err := Sign(priv, []byte("hallo"), "ctx")
	if err != nil {
		t.Fatal(err)
	}
	if !Verify(pub, []byte("hallo"), sig, "ctx") {
		t.Fatal("valid signature rejected")
	}
	if Verify(pub, []byte("hallo!"), sig, "ctx") || Verify(pub, []byte("hallo"), sig, "other") {
		t.Fatal("invalid signature accepted")
	}
}

func TestDerivationsAreDistinct(t *testing.T) {
	m := DeriveMaster(NewRoomCode())
	if bytes.Equal(HKDF(m, "a", 32), HKDF(m, "b", 32)) {
		t.Fatal("HKDF labels collide")
	}
	if bytes.Equal(DeriveSecret("pw", []byte("s1")), DeriveSecret("pw", []byte("s2"))) {
		t.Fatal("salt ignored")
	}
	if NormalizeAnswer("  Berlin   Mitte ") != "berlin mitte" {
		t.Fatal("answer normalization")
	}
}

func TestFingerprint(t *testing.T) {
	f := Fingerprint([]byte("a"), []byte("b"))
	if len(f) != 29 || f == Fingerprint([]byte("ab")) {
		t.Fatalf("fingerprint %q", f)
	}
}
