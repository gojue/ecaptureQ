// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

// Package auth provides optional Web authentication; Desktop does not install it.
package auth

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"strings"
)

const iterations = 600000

type Config struct {
	Username     string `json:"username"`
	PasswordHash string `json:"passwordHash"`
	// Nil defaults to Secure cookies. Explicit false supports local HTTP use.
	SecureCookie *bool `json:"secureCookie,omitempty"`
}

func (c Config) Validate() error {
	if c.Username == "" || len(c.Username) > 128 || strings.TrimSpace(c.Username) != c.Username {
		return errors.New("auth.username must be 1..128 bytes without surrounding whitespace")
	}
	_, _, err := parseHash(c.PasswordHash)
	return err
}

func parseHash(encoded string) (salt, key []byte, err error) {
	parts := strings.Split(encoded, "$")
	invalid := errors.New("auth.passwordHash must be a generated PBKDF2-SHA256 hash; use ecaptureq-web --hash-password")
	if len(parts) != 5 || parts[0] != "" || parts[1] != "pbkdf2-sha256" || parts[2] != "600000" {
		return nil, nil, invalid
	}
	salt, err = base64.RawStdEncoding.Strict().DecodeString(parts[3])
	if err != nil || len(salt) != 16 {
		return nil, nil, invalid
	}
	key, err = base64.RawStdEncoding.Strict().DecodeString(parts[4])
	if err != nil || len(key) != 32 {
		return nil, nil, invalid
	}
	return salt, key, nil
}

func HashPassword(password string) (string, error) {
	if len(password) < 8 || len(password) > 1024 {
		return "", errors.New("password must be 8..1024 bytes")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, iterations, 32)
	if err != nil {
		return "", err
	}
	return "$pbkdf2-sha256$600000$" + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(key), nil
}

func (c Config) matches(username, password string) bool {
	salt, expected, err := parseHash(c.PasswordHash)
	if err != nil || len(password) > 1024 {
		return false
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, iterations, 32)
	return err == nil && (subtle.ConstantTimeCompare(key, expected)&subtle.ConstantTimeCompare([]byte(username), []byte(c.Username))) == 1
}
