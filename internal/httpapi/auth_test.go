// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gojue/ecaptureq/frontend"
	"github.com/gojue/ecaptureq/internal/app"
	"github.com/gojue/ecaptureq/internal/auth"
)

func TestWebAuthMountAndDesktopBypass(t *testing.T) {
	hash, err := auth.HashPassword("synthetic-password")
	if err != nil {
		t.Fatal(err)
	}
	for _, base := range []string{"/", "/ecaptureq-web/"} {
		t.Run(base, func(t *testing.T) {
			config := app.Config{Auth: &auth.Config{Username: "tester", PasswordHash: hash}, HeaderCenter: "synthetic header", HiddenDomains: []string{"hidden.test"}}
			data, _ := json.Marshal(config)
			path := filepath.Join(t.TempDir(), "sources.json")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			opts := app.DefaultOptions()
			if err := app.LoadSources(path, &opts); err != nil {
				t.Fatal(err)
			}
			store, err := app.NewStore(opts)
			if err != nil {
				t.Fatal(err)
			}
			shared, err := New(opts, store, frontend.Files, Policy{})
			if err != nil {
				t.Fatal(err)
			}
			// Exactly the Desktop arrangement: shared Handler, no auth middleware,
			// even when the same sources config contains Web credentials.
			desktop, _ := Mount(base, shared)
			w := httptest.NewRecorder()
			desktop.ServeHTTP(w, httptest.NewRequest("GET", base+"api/workspace", nil))
			if w.Code != 200 || strings.Contains(w.Body.String(), hash) {
				t.Fatal("desktop affected by Web auth")
			}
			protected, err := auth.New(*opts.WebAuth, base, frontend.Files, shared, (Policy{}).ValidOrigin)
			if err != nil {
				t.Fatal(err)
			}
			defer protected.Close()
			web, _ := Mount(base, protected)
			call := func(method, route, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
				r := httptest.NewRequest(method, "https://example.test"+base+route, strings.NewReader(body))
				r.Header.Set("Origin", "https://example.test")
				r.Header.Set("X-Ecapture-UI", "1")
				r.Header.Set("Content-Type", "application/json")
				if cookie != nil {
					r.AddCookie(cookie)
				}
				w := httptest.NewRecorder()
				web.ServeHTTP(w, r)
				return w
			}
			if w := call("GET", "api/workspace", "", nil); w.Code != 401 {
				t.Fatal("Web did not require auth")
			}
			w = call("POST", "api/auth/login", `{"username":"tester","password":"synthetic-password"}`, nil)
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body)
			}
			cookie := w.Result().Cookies()[0]
			for _, route := range []string{"api/config", "api/status", "api/workspace", "api/changes"} {
				w = call("GET", route, "", cookie)
				if w.Code != 200 || strings.Contains(w.Body.String(), hash) || strings.Contains(w.Body.String(), "passwordHash") {
					t.Fatal(route, w.Code, "auth config exposed or route broken")
				}
			}
			w = call("POST", "api/sources", `{"endpoint":"ws://127.0.0.1:1/","label":"synthetic"}`, cookie)
			if w.Code != 201 {
				t.Fatal(w.Code, w.Body)
			}
			persisted, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var got app.Config
			if json.Unmarshal(persisted, &got) != nil || got.Auth == nil || got.Auth.PasswordHash != hash || got.Auth.Username != "tester" || got.HeaderCenter != config.HeaderCenter || len(got.Sources) != 1 {
				t.Fatal("adding a source lost configuration")
			}
		})
	}
}
