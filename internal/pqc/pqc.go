// Package pqc bundles every cryptographic primitive Nullraum uses.
//
// The same code runs natively (tests, tooling) and inside the browser as
// WebAssembly, so client-side crypto is Go standard library code instead of
// hand-rolled JavaScript.
//
//   - Key encapsulation: HPKE (RFC 9180) with the hybrid KEM
//     ML-KEM-768 + X25519, HKDF-SHA256 and ChaCha20-Poly1305.
//   - Signatures: ML-DSA-65 (FIPS 204).
//   - Symmetric encryption: XChaCha20-Poly1305 with 256-bit keys.
//   - Password/code hardening: Argon2id.
package pqc

import (
	"crypto/hkdf"
	"crypto/hpke"
	"crypto/mldsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
)

const KeySize = 32

var (
	ErrDecrypt = errors.New("pqc: decryption failed")
	ErrPadding = errors.New("pqc: invalid padding")
)

// Argon2id parameters. The room code already carries 150 bits of entropy;
// Argon2id makes guessing user-chosen passwords and answers expensive.
const (
	argonTime    = 3
	argonMemory  = 64 * 1024 // KiB
	argonThreads = 1
)

func Random(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

// DeriveMaster turns a normalized room code into the 32-byte room master
// secret. All other room secrets are derived from it with HKDF.
func DeriveMaster(normalizedCode string) []byte {
	return argon2.IDKey([]byte(normalizedCode), []byte("nullraum/v1/room-code"), argonTime, argonMemory, argonThreads, KeySize)
}

// DeriveSecret hardens the optional extra room protection (password, second
// key or the answers to three questions) with a per-room salt.
func DeriveSecret(secret string, salt []byte) []byte {
	return argon2.IDKey([]byte(secret), append([]byte("nullraum/v1/secret/"), salt...), argonTime, argonMemory, argonThreads, KeySize)
}

// NormalizeAnswer makes question answers robust against case and
// whitespace differences.
func NormalizeAnswer(s string) string {
	return strings.Join(strings.Fields(strings.ToLower(s)), " ")
}

func HKDF(secret []byte, info string, n int) []byte {
	k, err := hkdf.Key(sha256.New, secret, []byte("nullraum/v1"), info, n)
	if err != nil {
		panic(err)
	}
	return k
}

// pad hides the exact plaintext length: lengths are rounded up to a power of
// two (min 256 bytes) and above 64 KiB to a multiple of 64 KiB.
func pad(p []byte) []byte {
	n := len(p) + 4
	size := 256
	for size < n && size < 65536 {
		size <<= 1
	}
	if size < n {
		size = (n + 65535) / 65536 * 65536
	}
	out := make([]byte, size)
	binary.BigEndian.PutUint32(out, uint32(len(p)))
	copy(out[4:], p)
	return out
}

func unpad(p []byte) ([]byte, error) {
	if len(p) < 4 {
		return nil, ErrPadding
	}
	n := binary.BigEndian.Uint32(p)
	if uint64(n) > uint64(len(p)-4) {
		return nil, ErrPadding
	}
	return p[4 : 4+n], nil
}

// Seal pads and encrypts plaintext with XChaCha20-Poly1305. The output is
// nonce || ciphertext.
func Seal(key, plaintext, aad []byte) ([]byte, error) {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}
	nonce := Random(aead.NonceSize())
	return aead.Seal(nonce, nonce, pad(plaintext), aad), nil
}

func Open(key, data, aad []byte) ([]byte, error) {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}
	if len(data) < aead.NonceSize()+aead.Overhead() {
		return nil, ErrDecrypt
	}
	pt, err := aead.Open(nil, data[:aead.NonceSize()], data[aead.NonceSize():], aad)
	if err != nil {
		return nil, ErrDecrypt
	}
	return unpad(pt)
}

func kem() hpke.KEM { return hpke.MLKEM768X25519() }

// KEMGenerate returns a hybrid ML-KEM-768 + X25519 key pair.
func KEMGenerate() (priv, pub []byte, err error) {
	sk, err := kem().GenerateKey()
	if err != nil {
		return nil, nil, err
	}
	priv, err = sk.Bytes()
	if err != nil {
		return nil, nil, err
	}
	return priv, sk.PublicKey().Bytes(), nil
}

// KEMSeal encrypts plaintext to a hybrid public key (HPKE base mode).
func KEMSeal(pub []byte, info string, plaintext []byte) ([]byte, error) {
	pk, err := kem().NewPublicKey(pub)
	if err != nil {
		return nil, err
	}
	return hpke.Seal(pk, hpke.HKDFSHA256(), hpke.ChaCha20Poly1305(), []byte(info), pad(plaintext))
}

func KEMOpen(priv []byte, info string, ciphertext []byte) ([]byte, error) {
	sk, err := kem().NewPrivateKey(priv)
	if err != nil {
		return nil, err
	}
	pt, err := hpke.Open(sk, hpke.HKDFSHA256(), hpke.ChaCha20Poly1305(), []byte(info), ciphertext)
	if err != nil {
		return nil, ErrDecrypt
	}
	return unpad(pt)
}

// SigGenerate returns an ML-DSA-65 key pair. priv is the 32-byte seed.
func SigGenerate() (priv, pub []byte, err error) {
	sk, err := mldsa.GenerateKey(mldsa.MLDSA65())
	if err != nil {
		return nil, nil, err
	}
	return sk.Bytes(), sk.PublicKey().Bytes(), nil
}

func Sign(priv, msg []byte, context string) ([]byte, error) {
	sk, err := mldsa.NewPrivateKey(mldsa.MLDSA65(), priv)
	if err != nil {
		return nil, err
	}
	return sk.Sign(nil, msg, &mldsa.Options{Context: context})
}

func Verify(pub, msg, sig []byte, context string) bool {
	pk, err := mldsa.NewPublicKey(mldsa.MLDSA65(), pub)
	if err != nil {
		return false
	}
	return mldsa.Verify(pk, msg, sig, &mldsa.Options{Context: context}) == nil
}

// Fingerprint renders a 24-digit safety number (~80 bits) over the given
// public values, for out-of-band comparison.
func Fingerprint(parts ...[]byte) string {
	h := sha256.New()
	h.Write([]byte("nullraum/v1/fingerprint"))
	for _, p := range parts {
		var l [4]byte
		binary.BigEndian.PutUint32(l[:], uint32(len(p)))
		h.Write(l[:])
		h.Write(p)
	}
	sum := h.Sum(nil)
	groups := make([]string, 6)
	for i := range groups {
		groups[i] = fmt.Sprintf("%04d", binary.BigEndian.Uint32(sum[i*4:])%10000)
	}
	return strings.Join(groups, " ")
}

func SHA256(b []byte) []byte {
	s := sha256.Sum256(b)
	return s[:]
}
