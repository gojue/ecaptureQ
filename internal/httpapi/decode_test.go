// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
package httpapi

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"testing"

	"github.com/andybalholm/brotli"
)

func compressed(t *testing.T, encoding string, plain []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	var writer io.WriteCloser
	switch encoding {
	case "gzip":
		writer = gzip.NewWriter(&buffer)
	case "deflate":
		writer = zlib.NewWriter(&buffer)
	case "deflate-raw":
		writer, _ = flate.NewWriter(&buffer, flate.DefaultCompression)
	case "br":
		writer = brotli.NewWriter(&buffer)
	}
	if _, err := writer.Write(plain); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestDecodeFallbackFormatsAndLimits(t *testing.T) {
	plain := bytes.Repeat([]byte("捕获字节\x00\xff"), 128)
	for _, encoding := range []string{"gzip", "deflate", "deflate-raw", "br"} {
		t.Run(encoding, func(t *testing.T) {
			data := compressed(t, encoding, plain)
			got, err := decompressBody(context.Background(), encoding, data, len(plain))
			if err != nil || !bytes.Equal(got, plain) {
				t.Fatalf("decode mismatch: %v", err)
			}
			if _, err := decompressBody(context.Background(), encoding, data, len(plain)-1); !errors.Is(err, errDecodeLimit) {
				t.Fatalf("limit: %v", err)
			}
			if _, err := decompressBody(context.Background(), encoding, data[:len(data)/2], len(plain)); err == nil {
				t.Fatal("truncated body accepted")
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := decompressBody(ctx, "gzip", nil, 100); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := decompressBody(context.Background(), "unknown", nil, 100); !errors.Is(err, errDecodeUnsupported) {
		t.Fatal(err)
	}
}

func TestDecodeBodyHTTP(t *testing.T) {
	plain := []byte("local captured response")
	for _, tc := range []struct {
		name   string
		body   any
		status int
	}{
		{"ok", map[string]any{"encoding": "br", "body": compressed(t, "br", plain), "maxBytes": 1024}, 200},
		{"bomb", map[string]any{"encoding": "gzip", "body": compressed(t, "gzip", bytes.Repeat([]byte("x"), maxDecodedBody+1)), "maxBytes": maxDecodedBody}, 413},
		{"invalid", map[string]any{"encoding": "gzip", "body": []byte("bad"), "maxBytes": 1024}, 422},
		{"caller_limit", map[string]any{"encoding": "gzip", "body": []byte{}, "maxBytes": maxDecodedBody + 1}, 413},
		{"unsupported", map[string]any{"encoding": "zstd", "body": []byte{}, "maxBytes": 1024}, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(tc.body)
			r := httptest.NewRequest("POST", "/api/decode-body", bytes.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			decodeBody(w, r)
			if w.Code != tc.status {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
			if tc.status == 200 {
				var result struct{ Body []byte }
				if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || !bytes.Equal(result.Body, plain) {
					t.Fatalf("response %s", w.Body.String())
				}
			}
		})
	}
}
