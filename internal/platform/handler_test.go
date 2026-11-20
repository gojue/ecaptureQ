// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package platform

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gojue/ecaptureq/internal/app"
	"github.com/gojue/ecaptureq/internal/httpapi"
)

type fakeNative struct {
	calls  int
	saved  bool
	err    error
	value  string
	locale string
}

func (n *fakeNative) SaveFile(filename, content, locale string) (bool, error) {
	n.calls++
	n.value = filename + ":" + content
	n.locale = locale
	return n.saved, n.err
}
func (n *fakeNative) CopyText(text string) error { n.calls++; n.value = text; return n.err }
func (n *fakeNative) OpenURL(url string) error   { n.calls++; n.value = url; return n.err }

func (n *fakeNative) SaveArtifact(filename string, content io.Reader, locale string) (bool, error) {
	data, err := io.ReadAll(content)
	if err != nil {
		return false, err
	}
	return n.SaveFile(filename, string(data), locale)
}

type fakeArtifactSource struct{ manager *app.ArtifactManager }

func (s fakeArtifactSource) OpenArtifact(session, id string) (*app.ArtifactReader, error) {
	return s.manager.Open(session, id)
}

func TestNativeArtifactExportStreamsAuthorizedBytes(t *testing.T) {
	m, err := app.NewArtifactManager(app.NativeOptions{Dir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	a, err := m.Begin("session", "source", "synthetic", "tls", "pcapng", 2)
	if err != nil {
		t.Fatal(err)
	}
	// Deliberately unfinished binary bytes: exported as .partial, never complete.
	data := []byte{0x0a, 0x0d, 0x0d, 0x0a, 0x00, 0xff, 0x00}
	_, _ = a.Write(data)
	_ = a.Finish(false, "synthetic interruption")
	info := m.List()[0]
	for _, saved := range []bool{false, true} {
		native := &fakeNative{saved: saved}
		h := Wrap(http.NotFoundHandler(), native, httpapi.Policy{AdditionalOrigins: []string{"wails://localhost"}}, fakeArtifactSource{m})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, request("/api/platform/export-artifact", `{"session":"session","id":"`+info.ID+`","locale":"zh-CN"}`))
		if w.Code != 200 || native.calls != 1 || native.value != info.Filename+":"+string(data) || native.locale != "zh-CN" {
			t.Fatalf("binary export: %d %s %q", w.Code, w.Body, native.value)
		}
		if saved && !strings.Contains(w.Body.String(), `"saved":true`) || !saved && !strings.Contains(w.Body.String(), `"cancelled":true`) {
			t.Fatal(w.Body)
		}
	}
	for _, body := range []string{
		`{"session":"other","id":"` + info.ID + `"}`,
		`{"session":"session","id":"../secret"}`,
		`{"session":"session","id":"` + info.ID + `","path":"/private/file"}`,
		`{"session":"session","id":"` + info.ID + `","locale":"fr"}`,
	} {
		native := &fakeNative{}
		h := Wrap(http.NotFoundHandler(), native, httpapi.Policy{AdditionalOrigins: []string{"wails://localhost"}}, fakeArtifactSource{m})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, request("/api/platform/export-artifact", body))
		if (w.Code != 400 && w.Code != 404) || native.calls != 0 {
			t.Fatalf("untrusted binary request: %d %s", w.Code, w.Body)
		}
	}
	native := &fakeNative{}
	h := Wrap(http.NotFoundHandler(), native, httpapi.Policy{AdditionalOrigins: []string{"wails://localhost"}}, fakeArtifactSource{m})
	r := request("/api/platform/export-artifact", `{"session":"session","id":"`+info.ID+`"}`)
	r.Header.Set("Origin", "https://foreign.test")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 || native.calls != 0 {
		t.Fatal("binary save bypassed origin policy")
	}
}

func request(path, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "wails://localhost"+path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Ecapture-UI", "1")
	r.Header.Set("Origin", "wails://localhost")
	return r
}

func TestNativeActionsAndCancellation(t *testing.T) {
	for _, test := range []struct {
		path, body, expected string
		saved                bool
	}{
		{"/api/platform/export", `{"filename":"capture.json","content":"[]"}`, `"saved":true`, true},
		{"/api/platform/export", `{"filename":"capture.json","content":"[]"}`, `"cancelled":true`, false},
		{"/api/platform/clipboard", `{"text":"observed data"}`, `"ok":true`, false},
		{"/api/platform/open-url", `{"url":"https://example.com/path?q=1"}`, `"ok":true`, false},
	} {
		t.Run(test.path+test.expected, func(t *testing.T) {
			native := &fakeNative{saved: test.saved}
			h := Wrap(http.NotFoundHandler(), native, httpapi.Policy{AdditionalOrigins: []string{"wails://localhost"}})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, request(test.path, test.body))
			if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), test.expected) || native.calls != 1 {
				t.Fatalf("status=%d body=%s calls=%d", w.Code, w.Body, native.calls)
			}
		})
	}
}

func TestNativeRejectsUntrustedWrites(t *testing.T) {
	for _, test := range []struct {
		name, path, body string
		mutate           func(*http.Request)
		status           int
	}{
		{"foreign origin", "/api/platform/clipboard", `{"text":"x"}`, func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }, 403},
		{"null origin", "/api/platform/clipboard", `{"text":"x"}`, func(r *http.Request) { r.Header.Set("Origin", "null") }, 403},
		{"wrong wails host", "/api/platform/clipboard", `{"text":"x"}`, func(r *http.Request) { r.Header.Set("Origin", "wails://evil") }, 403},
		{"missing header", "/api/platform/clipboard", `{"text":"x"}`, func(r *http.Request) { r.Header.Del("X-Ecapture-UI") }, 403},
		{"cross site", "/api/platform/clipboard", `{"text":"x"}`, func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, 403},
		{"wrong type", "/api/platform/clipboard", `{"text":"x"}`, func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415},
		{"method", "/api/platform/clipboard", `{"text":"x"}`, func(r *http.Request) { r.Method = "GET" }, 405},
		{"filename traversal", "/api/platform/export", `{"filename":"../capture.json","content":"[]"}`, nil, 400},
		{"filename windows", "/api/platform/export", `{"filename":"C:\\capture.json","content":"[]"}`, nil, 400},
		{"unknown field", "/api/platform/export", `{"filename":"capture.json","content":"[]","path":"/tmp/x"}`, nil, 400},
		{"multiple values", "/api/platform/clipboard", `{"text":"x"} {"text":"y"}`, nil, 400},
		{"file url", "/api/platform/open-url", `{"url":"file:///etc/passwd"}`, nil, 400},
		{"javascript url", "/api/platform/open-url", `{"url":"javascript:alert(1)"}`, nil, 400},
		{"credential url", "/api/platform/open-url", `{"url":"https://user:pass@example.com/"}`, nil, 400},
		{"missing host", "/api/platform/open-url", `{"url":"https:///path"}`, nil, 400},
		{"unknown route", "/api/platform/run", `{"command":"echo test"}`, nil, 404},
	} {
		t.Run(test.name, func(t *testing.T) {
			native := &fakeNative{}
			h := Wrap(http.NotFoundHandler(), native, httpapi.Policy{AdditionalOrigins: []string{"wails://localhost"}})
			r := request(test.path, test.body)
			if test.mutate != nil {
				test.mutate(r)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != test.status || native.calls != 0 {
				t.Fatalf("status=%d want=%d body=%s calls=%d", w.Code, test.status, w.Body, native.calls)
			}
		})
	}
}

func TestExportLocaleValidation(t *testing.T) {
	for _, test := range []struct {
		name, field, locale string
	}{
		{"omitted", "", "en"},
		{"empty", `,"locale":""`, "en"},
		{"English", `,"locale":"en"`, "en"},
		{"Chinese", `,"locale":"zh-CN"`, "zh-CN"},
		{"unsupported", `,"locale":"fr"`, ""},
		{"case mismatch", `,"locale":"zh-cn"`, ""},
		{"arbitrary title", `,"locale":"A forged dialog title"`, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			native := &fakeNative{saved: true}
			h := Wrap(http.NotFoundHandler(), native, httpapi.Policy{AdditionalOrigins: []string{"wails://localhost"}})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, request("/api/platform/export", `{"filename":"capture.json","content":"[]"`+test.field+`}`))
			if test.locale == "" {
				if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"error":"invalid_locale"`) || native.calls != 0 {
					t.Fatalf("rejected locale: status=%d body=%s calls=%d", w.Code, w.Body, native.calls)
				}
				return
			}
			if w.Code != http.StatusOK || native.calls != 1 || native.locale != test.locale || native.value != "capture.json:[]" {
				t.Fatalf("accepted locale: status=%d body=%s calls=%d locale=%q value=%q", w.Code, w.Body, native.calls, native.locale, native.value)
			}
		})
	}
}

func TestNativeErrorIsVisibleWithoutLeakingPaths(t *testing.T) {
	native := &fakeNative{err: errors.New("permission denied: /private/user-secret")}
	h := Wrap(http.NotFoundHandler(), native, httpapi.Policy{AdditionalOrigins: []string{"wails://localhost"}})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, request("/api/platform/export", `{"filename":"capture.json","content":"[]"}`))
	if w.Code != 500 || !strings.Contains(w.Body.String(), "export_failed") || strings.Contains(w.Body.String(), "user-secret") {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
}

func TestPlatformMountedSubpath(t *testing.T) {
	native := &fakeNative{}
	h, err := httpapi.Mount("/ecaptureq-web/", Wrap(http.NotFoundHandler(), native, httpapi.Policy{AdditionalOrigins: []string{"wails://localhost"}}))
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, request("/ecaptureq-web/api/platform/clipboard", `{"text":"x"}`))
	if w.Code != 200 || native.value != "x" {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
	for _, method := range []string{"GET", "HEAD"} {
		r := httptest.NewRequest(method, "wails://localhost/ecaptureq-web/api/platform", nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 || (method == "HEAD" && w.Body.Len() != 0) {
			t.Fatalf("method=%s status=%d body=%s", method, w.Code, w.Body)
		}
	}
}
