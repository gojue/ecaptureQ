// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gojue/ecaptureq/frontend"
)

var testHash = sync.OnceValue(func() string {
	hash, err := HashPassword("synthetic-password")
	if err != nil {
		panic(err)
	}
	return hash
})

func testHandler(t *testing.T, next http.Handler) *Handler {
	t.Helper()
	h, err := New(Config{Username: "tester", PasswordHash: testHash()}, "/ecaptureq-web/", frontend.Files, next, func(r *http.Request) bool {
		return r.Header.Get("Origin") == "" || r.Header.Get("Origin") == "https://example.test"
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	return h
}
func request(h http.Handler, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "https://example.test"+path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Ecapture-UI", "1")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func login(t *testing.T, h *Handler) *http.Cookie {
	t.Helper()
	w := request(h, "POST", "/api/auth/login", `{"username":"tester","password":"synthetic-password"}`, nil)
	if w.Code != 200 || len(w.Result().Cookies()) != 1 {
		t.Fatalf("login: %d %s", w.Code, w.Body)
	}
	return w.Result().Cookies()[0]
}

func TestPasswordAndExample(t *testing.T) {
	c := Config{Username: "tester", PasswordHash: testHash()}
	if c.Validate() != nil || !c.matches("tester", "synthetic-password") || c.matches("other", "synthetic-password") || c.matches("tester", "wrong") {
		t.Fatal("password verification")
	}
	second, err := HashPassword("synthetic-password")
	if err != nil || second == c.PasswordHash {
		t.Fatal("salt not randomized")
	}
	for _, invalid := range []string{"", "plaintext", strings.Replace(testHash(), "600000", "1", 1), testHash() + "$extra"} {
		if (Config{Username: "tester", PasswordHash: invalid}).Validate() == nil {
			t.Fatal("accepted bad hash")
		}
	}
	for _, invalid := range []string{"short", strings.Repeat("x", 1025)} {
		if _, err := HashPassword(invalid); err == nil {
			t.Fatal("invalid password length")
		}
	}
	data, err := os.ReadFile("../../config/sources.example.json")
	if err != nil {
		t.Fatal(err)
	}
	var example struct {
		Auth Config `json:"auth"`
	}
	if json.Unmarshal(data, &example) != nil || example.Auth.Validate() != nil || !example.Auth.matches("ecapture", "ecaptureQ") {
		t.Fatal("example credentials do not match requested initial login")
	}
	if strings.Contains(string(data), `"password"`) {
		t.Fatal("example stores plaintext password")
	}
}

func TestProtectedRoutesCookiesAndLogout(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		w.Write([]byte("private workspace"))
	})
	h := testHandler(t, next)
	for _, path := range []string{"/api/workspace", "/api/record?id=x", "/api/changes", "/api/config", "/api/status", "/api/sources", "/api/health", "/api/version"} {
		w := request(h, "GET", path, "", nil)
		if w.Code != 401 || w.Header().Get("X-Ecaptureq-Auth") != "required" || strings.Contains(w.Body.String(), "private workspace") {
			t.Fatalf("unprotected %s", path)
		}
	}
	for _, path := range []string{"/", "/index.html", "/app.js", "/mock-data.json"} {
		w := request(h, "GET", path, "", nil)
		if w.Code != 303 || w.Header().Get("Location") != "/ecaptureq-web/login" {
			t.Fatal(path, w.Code)
		}
	}
	for _, path := range []string{"/login", "/login.js", "/login.css", "/i18n.js", "/messages.js", "/ecaptureq-logo.svg"} {
		if w := request(h, "GET", path, "", nil); w.Code != 200 {
			t.Fatal(path, w.Code)
		}
	}
	cookie := login(t, h)
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/ecaptureq-web/" || cookie.MaxAge != 43200 {
		t.Fatalf("cookie flags: %+v", cookie)
	}
	w := request(h, "GET", "/api/config", "", cookie)
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Ecaptureq-Auth") != "session" {
		t.Fatal(w.Code, w.Header())
	}
	w = request(h, "POST", "/api/auth/logout", "", cookie)
	if w.Code != 200 || w.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("logout")
	}
	if w = request(h, "GET", "/api/config", "", cookie); w.Code != 401 {
		t.Fatal("revoked cookie accepted")
	}
	other := testHandler(t, next)
	if w = request(other, "GET", "/api/config", "", login(t, h)); w.Code != 401 {
		t.Fatal("session accepted by another instance")
	}
}

func TestLoginBoundsAndOrigin(t *testing.T) {
	h := testHandler(t, http.NotFoundHandler())
	body := `{"username":"tester","password":"wrong"}`
	for _, origin := range []string{"https://foreign.test", "null", "wails://localhost"} {
		r := httptest.NewRequest("POST", "https://example.test/api/auth/login", strings.NewReader(body))
		r.Header.Set("Origin", origin)
		r.Header.Set("X-Ecapture-UI", "1")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal(origin, w.Code)
		}
	}
	r := httptest.NewRequest("POST", "https://example.test/api/auth/logout", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("missing custom header")
	}
	for _, body := range []string{`{"unexpected":1}`, `{} {}`, strings.Repeat(" ", 4097)} {
		if w := request(h, "POST", "/api/auth/login", body, nil); w.Code != 400 {
			t.Fatal("body bounds", w.Code)
		}
	}
	for range 5 {
		if w := request(h, "POST", "/api/auth/login", body, nil); w.Code != 401 {
			t.Fatal(w.Code)
		}
	}
	if w := request(h, "POST", "/api/auth/login", body, nil); w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Fatal("rate limit", w.Code)
	}
}

func TestLongPollRevocationExpiryAndRecheck(t *testing.T) {
	for _, kind := range []string{"logout", "expiry", "close"} {
		t.Run(kind, func(t *testing.T) {
			entered := make(chan struct{})
			h := testHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(entered)
				<-r.Context().Done()
				w.Write([]byte("must not escape"))
			}))
			cookie := login(t, h)
			key := sha256.Sum256([]byte(cookie.Value))
			if kind == "expiry" {
				h.mu.Lock()
				h.sessions[key].cancel()
				ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
				h.sessions[key] = &session{ctx: ctx, cancel: cancel}
				h.mu.Unlock()
			}
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() { done <- request(h, "GET", "/api/changes", "", cookie) }()
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("poll did not start")
			}
			switch kind {
			case "logout":
				request(h, "POST", "/api/auth/logout", "", cookie)
			case "close":
				h.Close()
			}
			select {
			case w := <-done:
				if w.Code != 401 || strings.Contains(w.Body.String(), "must not escape") {
					t.Fatal(w.Code, w.Body)
				}
			case <-time.After(time.Second):
				t.Fatal("poll not canceled")
			}
		})
	}
}

func TestSessionCapacityAndRotation(t *testing.T) {
	h := testHandler(t, http.NotFoundHandler())
	cookie := login(t, h)
	w := request(h, "POST", "/api/auth/login", `{"username":"tester","password":"synthetic-password"}`, cookie)
	if w.Code != 200 || w.Result().Cookies()[0].Value == cookie.Value || h.lookup(httptest.NewRequest("GET", "/", nil)) != nil {
		t.Fatal("rotation")
	}
	if w := request(h, "GET", "/api/config", "", cookie); w.Code != 401 {
		t.Fatal("old login not revoked")
	}
	h.mu.Lock()
	for i := len(h.sessions); i < maxSessions; i++ {
		ctx, cancel := context.WithCancel(context.Background())
		key := sha256.Sum256([]byte(strings.Repeat("x", i+1)))
		h.sessions[key] = &session{ctx: ctx, cancel: cancel}
	}
	h.mu.Unlock()
	if w := request(h, "POST", "/api/auth/login", `{"username":"tester","password":"synthetic-password"}`, nil); w.Code != 503 {
		t.Fatal("session table not bounded", w.Code)
	}
}
