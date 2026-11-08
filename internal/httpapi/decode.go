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
	"mime"
	"net/http"
	"time"

	"github.com/andybalholm/brotli"
)

const maxDecodedBody = 2 << 20

// Both frontends use this bounded fallback when their WebView/browser lacks a
// DecompressionStream format. It transforms captured bytes only; it never fetches
// the original resource and never changes retained records.
var decodeSlots = make(chan struct{}, 4)

func decodeBody(w http.ResponseWriter, r *http.Request) {
	fail := func(status int, code string) { writeJSON(w, r, status, []byte(`{"error":"`+code+`"}`)) }
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		fail(http.StatusUnsupportedMediaType, "json_required")
		return
	}
	var request struct {
		Encoding string `json:"encoding"`
		Body     []byte `json:"body"`
		MaxBytes int    `json:"maxBytes"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 3<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || decoder.Decode(new(any)) != io.EOF {
		fail(http.StatusBadRequest, "invalid")
		return
	}
	if len(request.Body) > maxDecodedBody || request.MaxBytes < 1 || request.MaxBytes > maxDecodedBody {
		fail(http.StatusRequestEntityTooLarge, "limit")
		return
	}
	select {
	case decodeSlots <- struct{}{}:
		defer func() { <-decodeSlots }()
	default:
		fail(http.StatusTooManyRequests, "busy")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	result, err := decompressBody(ctx, request.Encoding, request.Body, request.MaxBytes)
	if err != nil {
		code, status := "invalid", http.StatusUnprocessableEntity
		switch {
		case errors.Is(err, errDecodeLimit):
			code, status = "limit", http.StatusRequestEntityTooLarge
		case errors.Is(err, errDecodeUnsupported):
			code, status = "unsupported", http.StatusBadRequest
		case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
			code, status = "timeout", http.StatusRequestTimeout
		}
		fail(status, code)
		return
	}
	writeValue(w, r, struct {
		Body []byte `json:"body"`
	}{Body: result})
}

var (
	errDecodeLimit       = errors.New("decoded body limit exceeded")
	errDecodeUnsupported = errors.New("unsupported content encoding")
)

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	// Check the deadline between bounded chunks rather than starting an orphaned
	// decompression goroutine which could outlive the request.
	if len(p) > 32<<10 {
		p = p[:32<<10]
	}
	return r.reader.Read(p)
}

func decompressBody(ctx context.Context, encoding string, data []byte, limit int) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var reader io.Reader
	var closer io.Closer
	var err error
	source := bytes.NewReader(data)
	switch encoding {
	case "gzip":
		var decoded *gzip.Reader
		decoded, err = gzip.NewReader(source)
		reader, closer = decoded, decoded
	case "deflate":
		reader, err = zlib.NewReader(source)
		if err == nil {
			closer = reader.(io.Closer)
		}
	case "deflate-raw":
		decoded := flate.NewReader(source)
		reader, closer = decoded, decoded
	case "br":
		reader = brotli.NewReader(source)
	default:
		return nil, errDecodeUnsupported
	}
	if err != nil {
		return nil, err
	}
	if closer != nil {
		defer closer.Close()
	}
	result, err := io.ReadAll(io.LimitReader(contextReader{ctx, reader}, int64(limit)+1))
	if len(result) > limit {
		return nil, errDecodeLimit
	}
	if err != nil {
		return nil, err
	}
	return result, ctx.Err()
}
