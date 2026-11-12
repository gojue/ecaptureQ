// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package auth

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"strings"
	"sync"
	"time"
)

const sessionLifetime = 12 * time.Hour
const maxSessions = 128

type session struct {
	ctx    context.Context
	cancel context.CancelFunc
}

type Handler struct {
	config           Config
	base, cookieName string
	next             http.Handler
	assets           map[string][]byte
	validOrigin      func(*http.Request) bool
	mu               sync.Mutex
	sessions         map[[32]byte]*session
	tokens           float64
	refilled         time.Time
	closed           bool
	checks           chan struct{}
}

// New wraps paths after base-path stripping. Only cmd/server installs this layer.
func New(config Config, base string, files fs.FS, next http.Handler, validOrigin func(*http.Request) bool) (*Handler, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	h := &Handler{config: config, base: base, next: next, validOrigin: validOrigin, sessions: make(map[[32]byte]*session), assets: make(map[string][]byte), tokens: 5, refilled: time.Now(), checks: make(chan struct{}, 2)}
	// Distinguish sessions for different mounts on the same host (cookies have no port).
	h.cookieName = fmt.Sprintf("ecaptureq_session_%x", sha256.Sum256([]byte(base)))[:34]
	for _, name := range []string{"login.html", "login.js", "login.css", "i18n.js", "messages.js", "ecaptureq-logo.svg"} {
		data, err := fs.ReadFile(files, name)
		if err != nil {
			return nil, err
		}
		h.assets["/"+name] = data
	}
	return h, nil
}

func (h *Handler) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for key, s := range h.sessions {
		s.cancel()
		delete(h.sessions, key)
	}
}

func (h *Handler) cookie(token string, expires time.Time, maxAge int) *http.Cookie {
	return &http.Cookie{Name: h.cookieName, Value: token, Path: h.base, Expires: expires, MaxAge: maxAge, HttpOnly: true, Secure: h.config.SecureCookie == nil || *h.config.SecureCookie, SameSite: http.SameSiteStrictMode}
}

func (h *Handler) lookup(r *http.Request) *session {
	c, err := r.Cookie(h.cookieName)
	if err != nil || len(c.Value) != 43 {
		return nil
	}
	key := sha256.Sum256([]byte(c.Value))
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.sessions[key]
	if s != nil && s.ctx.Err() != nil {
		s.cancel()
		delete(h.sessions, key)
		return nil
	}
	return s
}

func reply(w http.ResponseWriter, r *http.Request, code int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	if r.Method != http.MethodHead {
		_ = json.NewEncoder(w).Encode(value)
	}
}

func (h *Handler) unauthorized(w http.ResponseWriter, r *http.Request) {
	w.Header().Del("Content-Length")
	w.Header().Set("X-Ecaptureq-Auth", "required")
	if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/api" || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		reply(w, r, http.StatusUnauthorized, map[string]string{"error": "authentication_required"})
	} else {
		http.Redirect(w, r, h.base+"login", http.StatusSeeOther)
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Ecaptureq-UI", "1")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "same-origin")
	if r.URL.Path == "/api/auth/login" || r.URL.Path == "/api/auth/logout" {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			reply(w, r, 405, map[string]string{"error": "method_not_allowed"})
			return
		}
		if r.Header.Get("X-Ecapture-UI") != "1" || r.Header.Get("Sec-Fetch-Site") == "cross-site" || !h.validOrigin(r) {
			reply(w, r, 403, map[string]string{"error": "origin_rejected"})
			return
		}
		if r.URL.Path == "/api/auth/login" {
			h.login(w, r)
		} else {
			h.logout(w, r)
		}
		return
	}
	assetPath := r.URL.Path
	if assetPath == "/login" {
		assetPath = "/login.html"
	}
	if data, ok := h.assets[assetPath]; ok && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		http.ServeContent(w, r, assetPath, time.Time{}, bytes.NewReader(data))
		return
	}
	s := h.lookup(r)
	if s == nil {
		h.unauthorized(w, r)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(s.ctx, cancel)
	defer stop()
	defer cancel()
	w.Header().Set("X-Ecaptureq-Auth", "session")
	guard := &sessionWriter{ResponseWriter: w, valid: func() bool { return s.ctx.Err() == nil }, reject: func() { h.unauthorized(w, r) }}
	h.next.ServeHTTP(guard, r.WithContext(ctx))
	if !guard.wrote && s.ctx.Err() != nil {
		h.unauthorized(w, r)
	}
}

// Recheck at the first write: an expired/revoked long poll must not send data.
type sessionWriter struct {
	http.ResponseWriter
	valid           func() bool
	reject          func()
	wrote, rejected bool
}

func (w *sessionWriter) WriteHeader(code int) {
	if w.wrote {
		return
	}
	w.wrote = true
	w.Header().Set("Cache-Control", "no-store")
	if !w.valid() {
		w.rejected = true
		w.reject()
		return
	}
	w.ResponseWriter.WriteHeader(code)
}
func (w *sessionWriter) Write(data []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(200)
	}
	if w.rejected {
		return len(data), nil
	}
	return w.ResponseWriter.Write(data)
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		reply(w, r, 415, map[string]string{"error": "json_required"})
		return
	}
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || len(input.Username) > 128 || len(input.Password) > 1024 {
		reply(w, r, 400, map[string]string{"error": "invalid_login"})
		return
	}
	h.mu.Lock()
	now := time.Now()
	h.tokens = min(5, h.tokens+now.Sub(h.refilled).Seconds()/12)
	h.refilled = now
	allowed := h.tokens >= 1 && !h.closed
	if allowed {
		h.tokens--
	}
	h.mu.Unlock()
	if !allowed {
		w.Header().Set("Retry-After", "12")
		reply(w, r, 429, map[string]string{"error": "login_rate_limited"})
		return
	}
	select {
	case h.checks <- struct{}{}:
		defer func() { <-h.checks }()
	default:
		w.Header().Set("Retry-After", "12")
		reply(w, r, 429, map[string]string{"error": "login_rate_limited"})
		return
	}
	if !h.config.matches(input.Username, input.Password) {
		reply(w, r, 401, map[string]string{"error": "invalid_credentials"})
		return
	}
	if r.Context().Err() != nil {
		return
	}
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		reply(w, r, 500, map[string]string{"error": "login_failed"})
		return
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	expires := time.Now().Add(sessionLifetime)
	h.mu.Lock()
	defer h.mu.Unlock()
	for key, s := range h.sessions {
		if s.ctx.Err() != nil {
			s.cancel()
			delete(h.sessions, key)
		}
	}
	if old, err := r.Cookie(h.cookieName); err == nil {
		key := sha256.Sum256([]byte(old.Value))
		if s := h.sessions[key]; s != nil {
			s.cancel()
			delete(h.sessions, key)
		}
	}
	if h.closed || len(h.sessions) >= maxSessions {
		reply(w, r, 503, map[string]string{"error": "session_limit"})
		return
	}
	ctx, cancel := context.WithDeadline(context.Background(), expires)
	h.sessions[sha256.Sum256([]byte(token))] = &session{ctx: ctx, cancel: cancel}
	http.SetCookie(w, h.cookie(token, expires, int(sessionLifetime.Seconds())))
	reply(w, r, 200, map[string]bool{"ok": true})
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(h.cookieName); err == nil {
		key := sha256.Sum256([]byte(c.Value))
		h.mu.Lock()
		if s := h.sessions[key]; s != nil {
			s.cancel()
			delete(h.sessions, key)
		}
		h.mu.Unlock()
	}
	http.SetCookie(w, h.cookie("", time.Unix(1, 0), -1))
	reply(w, r, 200, map[string]bool{"ok": true})
}
