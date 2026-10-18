package pqc

import (
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"math/big"
	"strings"
)

// Crockford base32: no I, L, O, U, so codes survive being written on paper.
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

const (
	codeDataLen  = 30 // 30 symbols * 5 bits = 150 bits of entropy
	codeCheckLen = 2
	keyDataLen   = 24 // second keys: 120 bits
)

var (
	ErrCodeLength   = errors.New("Der Code hat nicht die richtige Länge.")
	ErrCodeChecksum = errors.New("Der Code enthält einen Tippfehler (Prüfsumme stimmt nicht).")
	ErrCodeChar     = errors.New("Der Code enthält ungültige Zeichen.")
)

func randomSymbols(n int) string {
	var sb strings.Builder
	max := big.NewInt(int64(len(alphabet)))
	for range n {
		i, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic(err)
		}
		sb.WriteByte(alphabet[i.Int64()])
	}
	return sb.String()
}

func checksum(data string) string {
	sum := sha256.Sum256([]byte("nullraum/v1/code-check/" + data))
	v := int(sum[0])<<2 | int(sum[1])>>6 // 10 bits
	return string([]byte{alphabet[v>>5], alphabet[v&31]})
}

func group(s string) string {
	var parts []string
	for i := 0; i < len(s); i += 4 {
		parts = append(parts, s[i:min(i+4, len(s))])
	}
	return strings.Join(parts, "-")
}

// NewRoomCode returns a fresh room code like "7KQF-3MXZ-...". It has 8
// groups of four symbols: 150 random bits plus a 10-bit typo checksum.
func NewRoomCode() string {
	data := randomSymbols(codeDataLen)
	return group(data + checksum(data))
}

// NewSecondKey returns a random secondary room key (120 bits), meant to be
// shared over a different channel than the room code.
func NewSecondKey() string {
	return group(randomSymbols(keyDataLen))
}

// normalize upper-cases, drops separators and maps look-alike characters.
func normalize(s string) (string, error) {
	var sb strings.Builder
	for _, r := range strings.ToUpper(s) {
		switch r {
		case ' ', '-', '_', '.', '\t', '\n', '\r':
			continue
		case 'O':
			r = '0'
		case 'I', 'L':
			r = '1'
		case 'U':
			r = 'V'
		}
		if !strings.ContainsRune(alphabet, r) {
			return "", ErrCodeChar
		}
		sb.WriteRune(r)
	}
	return sb.String(), nil
}

// ParseRoomCode validates a user-typed code and returns its canonical form
// (grouped, upper case), which is the input to DeriveMaster.
func ParseRoomCode(s string) (string, error) {
	n, err := normalize(s)
	if err != nil {
		return "", err
	}
	if len(n) != codeDataLen+codeCheckLen {
		return "", ErrCodeLength
	}
	if checksum(n[:codeDataLen]) != n[codeDataLen:] {
		return "", ErrCodeChecksum
	}
	return group(n), nil
}

// NormalizeSecondKey canonicalizes a typed second key.
func NormalizeSecondKey(s string) (string, error) {
	n, err := normalize(s)
	if err != nil {
		return "", err
	}
	return group(n), nil
}
