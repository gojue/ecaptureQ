// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package app

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	DefaultNativeBytes    int64 = 1 << 30
	DefaultNativeSessions       = 32
)

var (
	ErrArtifactNotFound = errors.New("artifact_not_found")
	ErrNativeLimit      = errors.New("native_storage_limit")
)

// NativeOptions bounds temporary session storage independently of record JSON.
// Directory is a parent directory; each app creates its own private child.
type NativeOptions struct {
	Dir         string `json:"directory,omitempty"`
	MaxBytes    int64  `json:"maxBytes,omitempty"`
	MaxSessions int    `json:"maxSessions,omitempty"`
}

func (o NativeOptions) normalized() NativeOptions {
	if o.MaxBytes == 0 {
		o.MaxBytes = DefaultNativeBytes
	}
	if o.MaxSessions == 0 {
		o.MaxSessions = DefaultNativeSessions
	}
	return o
}

func (o NativeOptions) validate() error {
	o = o.normalized()
	if o.MaxBytes < 1 || o.MaxBytes > 1<<40 || o.MaxSessions < 1 || o.MaxSessions > 1024 {
		return errors.New("native storage requires 1..1099511627776 bytes and 1..1024 sessions")
	}
	return nil
}

type ArtifactInfo struct {
	ID          string `json:"id"`
	Session     string `json:"session"`
	SourceID    string `json:"sourceId"`
	SourceLabel string `json:"sourceLabel"`
	Module      string `json:"module"`
	Format      string `json:"format"`
	Bytes       int64  `json:"bytes"`
	StartedAt   string `json:"startedAt"`
	EndedAt     string `json:"endedAt,omitempty"`
	Generation  uint64 `json:"generation"`
	State       string `json:"state"`
	Error       string `json:"error,omitempty"`
	Filename    string `json:"filename"`
}

type syncedWriter interface {
	io.WriteCloser
	Sync() error
}

// ArtifactManager owns only app-created temporary files. Downloads and desktop
// saves copy bytes to user-owned destinations, which this manager never tracks
// or deletes. Disk writes do not hold Store.mu or the metadata mutex.
type ArtifactManager struct {
	mu           sync.Mutex
	options      NativeOptions
	dir          string
	items        map[string]*ArtifactWriter
	order        []string
	bytes        int64
	closed       bool
	cleanupReady bool
}

type ArtifactWriter struct {
	mu       sync.Mutex
	manager  *ArtifactManager
	file     syncedWriter
	path     string
	finished bool
	failure  string
	// info and readers are protected by manager.mu, never by Store.mu.
	info    ArtifactInfo
	readers int
}

func NewArtifactManager(options NativeOptions) (*ArtifactManager, error) {
	if err := options.validate(); err != nil {
		return nil, err
	}
	return &ArtifactManager{options: options.normalized(), items: make(map[string]*ArtifactWriter)}, nil
}

func (m *ArtifactManager) Begin(session, sourceID, label, module, format string, generation uint64) (*ArtifactWriter, error) {
	if format != "keylog" && format != "pcapng" {
		return nil, errors.New("invalid_native_format")
	}
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		return nil, errors.New("native_create_failed")
	}
	id := hex.EncodeToString(token[:])
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, errors.New("service_stopping")
	}
	if err := m.makeRoomLocked(0, true); err != nil {
		return nil, err
	}
	if m.dir == "" {
		dir, err := os.MkdirTemp(m.options.Dir, "ecaptureq-native-*")
		if err != nil {
			return nil, errors.New("native_create_failed")
		}
		m.dir = dir // MkdirTemp creates mode 0700, regardless of the parent mode.
	}
	filename := "ecaptureq-" + id + "." + format + ".partial"
	path := filepath.Join(m.dir, filename)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, errors.New("native_create_failed")
	}
	a := &ArtifactWriter{manager: m, file: f, path: path, info: ArtifactInfo{
		ID: id, Session: session, SourceID: sourceID, SourceLabel: label, Module: module,
		Format: format, Generation: generation, StartedAt: time.Now().UTC().Format(time.RFC3339Nano),
		State: "receiving", Filename: filename,
	}}
	m.items[id] = a
	m.order = append(m.order, id)
	return a, nil
}

// makeRoomLocked evicts only finished, unleased session files, oldest first.
// Active downloads and active capture writers are never evicted.
func (m *ArtifactManager) makeRoomLocked(extra int64, addSession bool) error {
	if extra > m.options.MaxBytes {
		return ErrNativeLimit
	}
	needed := func() bool {
		return extra > m.options.MaxBytes-m.bytes || (addSession && len(m.items) >= m.options.MaxSessions)
	}
	for needed() {
		removed := false
		for i, id := range m.order {
			a := m.items[id]
			if a.info.State == "receiving" || a.readers != 0 {
				continue
			}
			if err := os.Remove(a.path); err != nil && !errors.Is(err, os.ErrNotExist) {
				continue
			}
			m.bytes -= a.info.Bytes
			delete(m.items, id)
			m.order = append(m.order[:i], m.order[i+1:]...)
			removed = true
			break
		}
		if !removed {
			return ErrNativeLimit
		}
	}
	return nil
}

func (a *ArtifactWriter) Write(data []byte) (int, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.finished || a.failure != "" {
		return 0, errors.New("native_stream_closed")
	}
	m := a.manager
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		a.failure = "service_stopping"
		return 0, errors.New(a.failure)
	}
	err := m.makeRoomLocked(int64(len(data)), false)
	if err == nil {
		m.bytes += int64(len(data))
	}
	m.mu.Unlock()
	if err != nil {
		a.failure = ErrNativeLimit.Error()
		return 0, err
	}
	n, err := a.file.Write(data)
	if err == nil && n != len(data) {
		err = io.ErrShortWrite
	}
	m.mu.Lock()
	m.bytes -= int64(len(data) - n)
	a.info.Bytes += int64(n)
	m.mu.Unlock()
	if err != nil {
		a.failure = "native_write_failed"
		return n, errors.New(a.failure)
	}
	return n, nil
}

// Finish is called only after the receive loop observes its actual close state.
// A valid file boundary alone can never turn an interrupted stream into complete.
func (a *ArtifactWriter) Finish(normal bool, reason string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.finished {
		return nil
	}
	a.finished = true
	if err := a.file.Sync(); err != nil {
		a.failure = "native_flush_failed"
	}
	if err := a.file.Close(); err != nil {
		a.failure = "native_close_failed"
	}
	state := "partial"
	if normal && a.failure == "" {
		input, err := os.Open(a.path)
		if err == nil {
			err = validateNative(input, a.info.Format)
			err = errors.Join(err, input.Close())
		}
		if err != nil {
			a.failure = "native_format_invalid"
		} else {
			complete := a.path[:len(a.path)-len(".partial")]
			// Linking refuses an existing destination instead of overwriting it.
			if err = os.Link(a.path, complete); err != nil {
				a.failure = "native_finalize_failed"
			} else if err = os.Remove(a.path); err != nil {
				_ = os.Remove(complete)
				a.failure = "native_finalize_failed"
			} else {
				a.path = complete
				state = "complete"
			}
		}
	}
	if a.failure != "" {
		state = "failed"
		reason = a.failure
	}
	if state == "partial" && reason == "" {
		reason = "stream_interrupted"
	}
	if state == "complete" {
		reason = ""
	}
	m := a.manager
	m.mu.Lock()
	a.info.State, a.info.Error, a.info.Filename = state, reason, filepath.Base(a.path)
	a.info.EndedAt = time.Now().UTC().Format(time.RFC3339Nano)
	m.mu.Unlock()
	if a.failure != "" {
		return errors.New(a.failure)
	}
	return nil
}

func (m *ArtifactManager) List() []ArtifactInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	items := make([]ArtifactInfo, 0, len(m.order))
	for _, id := range m.order {
		items = append(items, m.items[id].info)
	}
	return items
}

// ArtifactReader is a fixed-size snapshot, even while capture is still active.
// Its lease prevents quota cleanup until the HTTP response or save completes.
type ArtifactReader struct {
	*io.SectionReader
	Info   ArtifactInfo
	file   *os.File
	writer *ArtifactWriter
	once   sync.Once
	err    error
}

func (m *ArtifactManager) Open(session, id string) (*ArtifactReader, error) {
	if len(id) != 32 {
		return nil, ErrArtifactNotFound
	}
	if _, err := hex.DecodeString(id); err != nil {
		return nil, ErrArtifactNotFound
	}
	m.mu.Lock()
	a := m.items[id]
	if m.closed || a == nil || session == "" || a.info.Session != session {
		m.mu.Unlock()
		return nil, ErrArtifactNotFound
	}
	a.readers++
	m.mu.Unlock()
	a.mu.Lock()
	f, err := openArtifactFileReader(a.path)
	m.mu.Lock()
	info := a.info
	if err != nil {
		a.readers--
	}
	m.mu.Unlock()
	a.mu.Unlock()
	if err != nil {
		return nil, ErrArtifactNotFound
	}
	return &ArtifactReader{SectionReader: io.NewSectionReader(f, 0, info.Bytes), Info: info, file: f, writer: a}, nil
}

func (r *ArtifactReader) Close() error {
	r.once.Do(func() {
		r.err = r.file.Close()
		m := r.writer.manager
		m.mu.Lock()
		r.writer.readers--
		if m.closed {
			m.cleanupLocked()
		}
		m.mu.Unlock()
	})
	return r.err
}

func (m *ArtifactManager) cleanupLocked() {
	if !m.cleanupReady {
		return
	}
	for _, a := range m.items {
		if a.readers != 0 {
			return
		}
	}
	if m.dir != "" {
		_ = os.RemoveAll(m.dir)
	}
}

func (m *ArtifactManager) Close() error {
	m.mu.Lock()
	m.closed = true
	items := make([]*ArtifactWriter, 0, len(m.items))
	for _, a := range m.items {
		items = append(items, a)
	}
	m.mu.Unlock()
	var result error
	for _, a := range items {
		result = errors.Join(result, a.Finish(false, "service_stopping"))
	}
	m.mu.Lock()
	m.cleanupReady = true
	m.cleanupLocked()
	m.mu.Unlock()
	return result
}

func (s *Store) Artifacts() []ArtifactInfo { return s.artifacts.List() }

func (s *Store) OpenArtifact(session, id string) (*ArtifactReader, error) {
	if session != s.started.UTC().Format(time.RFC3339Nano) {
		return nil, ErrArtifactNotFound
	}
	return s.artifacts.Open(session, id)
}

func validateNative(input io.Reader, format string) error {
	switch format {
	case "keylog":
		return validateKeylog(input)
	case "pcapng":
		return validatePcapng(input)
	default:
		return fmt.Errorf("invalid native format")
	}
}
