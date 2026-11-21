// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package app

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gojue/ecaptureq/internal/auth"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	pb "github.com/gojue/ecapture/v2/protobuf/gen/v2"
	protocol "github.com/gojue/ecapture/v2/protobuf/v2"
)

type Options struct {
	Native                NativeOptions
	WebAuth               *auth.Config
	Mode                  string
	ExcludeHTTPPathPrefix string
	Endpoints             []string
	Sources               []SourceConfig
	SourcesFile           string
	SourcesHash           [32]byte
	HeaderCenter          string
	HiddenDomains         []string
	MaxRecords            int
	MaxBytes              int
	MaxFrameBytes         int
	ReadTimeout           time.Duration
	ReconnectDelay        time.Duration
	MaxReconnectWait      time.Duration
}

func DefaultOptions() Options {
	return Options{Mode: "mock", MaxRecords: 65536, MaxBytes: 192 << 20, MaxFrameBytes: 8 << 20, ReadTimeout: 45 * time.Second, ReconnectDelay: time.Second, MaxReconnectWait: 15 * time.Second, HiddenDomains: defaultHiddenDomains}
}

func (o Options) Validate() error {
	if err := o.Native.validate(); err != nil {
		return err
	}
	if o.Mode != "mock" && o.Mode != "live" {
		return errors.New("mode must be mock or live")
	}
	if prefix := o.ExcludeHTTPPathPrefix; prefix != "" && (!strings.HasPrefix(prefix, "/") || strings.ContainsAny(prefix, "?#\r\n")) {
		return errors.New("excluded HTTP path prefix must be an absolute path without query or fragment")
	}
	if len(o.Endpoints) > 16 {
		return errors.New("at most 16 eCaptureQ endpoints are supported")
	}
	if o.MaxRecords < 1 || o.MaxRecords > 100000 || o.MaxBytes < 1024 || o.MaxBytes > 1<<30 || o.MaxFrameBytes < 1024 || o.MaxFrameBytes > 64<<20 {
		return errors.New("retention or frame limit is outside the supported range")
	}
	if o.ReadTimeout <= 0 || o.ReconnectDelay <= 0 || o.MaxReconnectWait < o.ReconnectDelay {
		return errors.New("connection timeouts must be positive and reconnect bounds ordered")
	}
	seen := make(map[string]bool)
	for _, endpoint := range o.Endpoints {
		canonical, err := normalizeEndpoint(endpoint)
		if err != nil {
			return err
		}
		if seen[canonical] {
			return errors.New("ecaptureq endpoints must be unique")
		}
		seen[canonical] = true
	}
	return nil
}

func normalizeEndpoint(endpoint string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil || len(endpoint) > 2048 || u.Hostname() == "" || (u.Scheme != "ws" && u.Scheme != "wss") || u.User != nil || u.Fragment != "" || u.RawQuery != "" || u.ForceQuery || u.Opaque != "" {
		return "", errors.New("invalid_endpoint")
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && ip.IsUnspecified() {
		return "", errors.New("invalid_endpoint")
	}
	u.Host = strings.ToLower(u.Host)
	if port := u.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return "", errors.New("invalid_endpoint")
		}
		if (port == "80" && u.Scheme == "ws") || (port == "443" && u.Scheme == "wss") {
			u.Host = strings.TrimSuffix(u.Host, ":"+port)
		}
	}
	if u.Path == "" {
		u.Path = "/"
	}
	return u.String(), nil
}

type CaptureInfo struct {
	Host             string `json:"host"`
	Module           string `json:"module"`
	Mode             string `json:"mode"`
	TextSource       string `json:"textSource"`
	Command          string `json:"command"`
	CollectorCommit  string `json:"collectorCommit,omitempty"`
	DecryptorVersion string `json:"decryptorVersion,omitempty"`
}

type SourceConfig struct {
	Endpoint string       `json:"endpoint"`
	Label    string       `json:"label"`
	Capture  *CaptureInfo `json:"capture,omitempty"`
}

type SourceStatus struct {
	ID            string         `json:"id"`
	Persistent    bool           `json:"persistent"`
	Label         string         `json:"label"`
	Endpoint      string         `json:"endpoint"`
	Capture       *CaptureInfo   `json:"capture,omitempty"`
	Collector     *CollectorInfo `json:"collector,omitempty"`
	State         string         `json:"state"`
	Generation    uint64         `json:"generation"`
	Received      uint64         `json:"received"`
	Events        uint64         `json:"events"`
	Malformed     uint64         `json:"malformed"`
	Ignored       uint64         `json:"ignored"`
	Reconnects    uint64         `json:"reconnects"`
	Retries       uint64         `json:"retries"`
	LastEventAt   string         `json:"lastEventAt,omitempty"`
	LastHeartbeat string         `json:"lastHeartbeatAt,omitempty"`
	LastError     string         `json:"lastError,omitempty"`
}

type operationalLog struct {
	Module     string `json:"module"`
	SourceID   string `json:"sourceId"`
	ReceivedAt string `json:"receivedAt"`
	Message    string `json:"message"`
}

type Status struct {
	Artifacts             []ArtifactInfo   `json:"artifacts"`
	Session               string           `json:"session"`
	Revision              uint64           `json:"revision"`
	RecordsRevision       uint64           `json:"recordsRevision"`
	State                 string           `json:"state"`
	Sources               []SourceStatus   `json:"sources"`
	Received              uint64           `json:"received"`
	Events                uint64           `json:"events"`
	Malformed             uint64           `json:"malformed"`
	Ignored               uint64           `json:"ignored"`
	Dropped               uint64           `json:"dropped"`
	Filtered              uint64           `json:"filtered"`
	ExcludeHTTPPathPrefix string           `json:"excludeHTTPPathPrefix,omitempty"`
	Evicted               uint64           `json:"evicted"`
	Retained              int              `json:"retained"`
	RetainedBytes         int              `json:"retainedBytes"`
	MaxRecords            int              `json:"maxRecords"`
	MaxBytes              int              `json:"maxBytes"`
	LastEventAt           string           `json:"lastEventAt,omitempty"`
	Logs                  []operationalLog `json:"logs"`
	SourcePersistence     string           `json:"sourcePersistence"`
}

type processInfo struct {
	ID               string `json:"id"`
	PID              any    `json:"pid"`
	Name             string `json:"name"`
	Kind             string `json:"kind"`
	Command          string `json:"command"`
	CommandTruncated bool   `json:"commandTruncated,omitempty"`
	Source           string `json:"source"`
}

type storedRecord struct {
	Summary         Record
	HasJSON         bool
	JSON            json.RawMessage
	Process         processInfo
	ResponseProcess *processInfo
}

type Store struct {
	artifacts    *ArtifactManager
	mu           sync.Mutex
	sourceMu     sync.Mutex // Serializes source lifecycle changes, including stop/join.
	sourceRuns   [16]sourceRun
	nextSourceID uint64
	// Serializes association and retention updates across source connectors, so
	// another source cannot evict a request between its lookup and upsert.
	ingestMu        sync.Mutex
	options         Options
	sources         []SourceStatus
	records         map[string]storedRecord
	order           []string
	logs            []operationalLog
	bytes           int
	dropped         uint64
	filtered        uint64
	evicted         uint64
	revision        uint64
	recordsRevision uint64
	changed         chan struct{}
	host            string
	started         time.Time
	wg              sync.WaitGroup
	ctx             context.Context
	closing         bool
}

func NewStore(options Options) (*Store, error) {
	if err := options.Validate(); err != nil {
		return nil, err
	}
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "采集服务"
	}
	artifacts, err := NewArtifactManager(options.Native)
	if err != nil {
		return nil, err
	}
	s := &Store{artifacts: artifacts, options: options, records: make(map[string]storedRecord), sources: []SourceStatus{}, logs: []operationalLog{}, host: host, started: time.Now(), changed: make(chan struct{})}
	for index, endpoint := range options.Endpoints {
		canonical, _ := normalizeEndpoint(endpoint) // Validated above.
		u, _ := url.Parse(canonical)
		source := SourceStatus{ID: fmt.Sprintf("source-%d", index+1), Label: u.Host, Endpoint: canonical, State: "connecting"}
		for _, configured := range options.Sources {
			if configured.Endpoint == endpoint {
				source.Persistent = options.SourcesFile != ""
				if configured.Label != "" {
					source.Label = configured.Label
				}
				source.Capture = configured.Capture
			}
		}
		s.sources = append(s.sources, source)
	}
	s.nextSourceID = uint64(len(s.sources))
	return s, nil
}

// Start is called once. Every connector owns its mapper; reconnecting starts a
// new generation so requests across a capture gap are never paired together.
func (s *Store) Start(ctx context.Context) {
	s.sourceMu.Lock()
	defer s.sourceMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx != nil || s.closing {
		return
	}
	s.ctx = ctx
	for index := range s.sources {
		if s.sources[index].ID != "" {
			s.startSourceLocked(index)
		}
	}
}

func (s *Store) startSourceLocked(index int) {
	ctx, cancel := context.WithCancel(s.ctx)
	done := make(chan struct{})
	s.sourceRuns[index] = sourceRun{cancel: cancel, done: done}
	s.wg.Add(1)
	go func() { defer s.wg.Done(); defer close(done); s.connect(ctx, index) }()
}

func (s *Store) Wait() {
	s.sourceMu.Lock()
	s.mu.Lock()
	s.closing = true
	s.notifyLocked()
	s.mu.Unlock()
	s.sourceMu.Unlock()
	s.wg.Wait()
	_ = s.artifacts.Close()
}

// AddSource publishes the new source only after any configured persistence
// succeeds. Existing connectors and their correlation generations stay intact.
func (s *Store) AddSource(config SourceConfig) (SourceStatus, error) {
	config, err := normalizeSource(config)
	if err != nil {
		return SourceStatus{}, err
	}
	s.sourceMu.Lock()
	defer s.sourceMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing || (s.ctx != nil && s.ctx.Err() != nil) {
		return SourceStatus{}, errors.New("service_stopping")
	}
	for _, source := range s.sources {
		if source.ID != "" && source.Endpoint == config.Endpoint {
			return SourceStatus{}, errors.New("duplicate_source")
		}
	}
	if s.activeSourceCountLocked() >= 16 {
		return SourceStatus{}, errors.New("source_limit")
	}
	if s.options.SourcesFile != "" {
		if err := s.persistSourcesLocked(append(append([]SourceConfig(nil), s.options.Sources...), config)); err != nil {
			return SourceStatus{}, err
		}
	}
	s.nextSourceID++
	source := SourceStatus{ID: fmt.Sprintf("source-%d", s.nextSourceID), Persistent: s.options.SourcesFile != "", Label: config.Label, Endpoint: config.Endpoint, Capture: config.Capture, State: "connecting"}
	index := 0
	for index < len(s.sources) && s.sources[index].ID != "" {
		index++
	}
	if index == len(s.sources) {
		s.sources = append(s.sources, source)
	} else {
		s.sources[index] = source
	}
	s.notifyLocked()
	if s.ctx != nil {
		s.startSourceLocked(index)
	}
	return source, nil
}

func (s *Store) persistSourcesLocked(configs []SourceConfig) error {
	path := s.options.SourcesFile
	current, err := os.ReadFile(path)
	if err != nil {
		return errors.New("source_save_failed")
	}
	if sha256.Sum256(current) != s.options.SourcesHash {
		return errors.New("source_config_changed")
	}
	data, err := json.MarshalIndent(Config{
		Auth:          s.options.WebAuth,
		Native:        s.options.Native,
		Sources:       configs,
		HeaderCenter:  s.options.HeaderCenter,
		HiddenDomains: s.options.HiddenDomains,
	}, "", "  ")
	if err != nil || len(data) > 128<<10 {
		return errors.New("source_config_too_large")
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".ecaptureq-sources-*")
	if err != nil {
		return errors.New("source_save_failed")
	}
	defer func() { _ = os.Remove(file.Name()) }()
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		return errors.New("source_save_failed")
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return errors.New("source_save_failed")
	}
	s.options.Sources, s.options.SourcesHash = configs, sha256.Sum256(data)
	return nil
}

func (s *Store) updateSource(index int, update func(*SourceStatus)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	update(&s.sources[index])
	s.notifyLocked()
}

// Module names are open-ended, but metadata retained outside record JSON must
// remain bounded just like operational log messages.
func validateEntry(entry *pb.LogEntry) error {
	if err := protocol.ValidateLogEntry(entry); err != nil {
		return err
	}
	if len(entry.Module) > 256 {
		return errors.New("module exceeds 256 bytes")
	}
	return nil
}

var errNonBinaryFrame = errors.New("protocol_error: expected binary WebSocket message")
var errSubprotocol = errors.New("protocol_error: ecapture.v2 subprotocol required")

func (s *Store) connect(ctx context.Context, index int) {
	delay := s.options.ReconnectDelay
	defer s.updateSource(index, func(source *SourceStatus) { source.State = "stopped" })
	for ctx.Err() == nil {
		s.mu.Lock()
		endpoint := s.sources[index].Endpoint
		s.mu.Unlock()
		dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		conn, response, err := websocket.Dial(dialCtx, endpoint, &websocket.DialOptions{
			Subprotocols: []string{protocol.Subprotocol}, HTTPHeader: http.Header{"Origin": {"http://localhost"}},
		})
		cancel()
		if err != nil && response != nil && response.StatusCode >= 400 {
			err = fmt.Errorf("protocol_handshake_failed: HTTP %d: %w", response.StatusCode, err)
		}
		if err == nil && conn.Subprotocol() != protocol.Subprotocol {
			_ = conn.CloseNow()
			err = errSubprotocol
		}
		if err == nil {
			conn.SetReadLimit(int64(s.options.MaxFrameBytes))
			var generation uint64
			s.updateSource(index, func(source *SourceStatus) {
				if source.Generation > 0 {
					source.Reconnects++
				}
				source.Generation++
				source.Collector = nil
				generation = source.Generation
				source.State = "connected"
				source.LastError = ""
			})
			connectedAt := time.Now()
			err = s.receive(ctx, index, generation, conn)
			_ = conn.CloseNow()
			if time.Since(connectedAt) >= 15*time.Second {
				delay = s.options.ReconnectDelay
			}
		}
		if ctx.Err() != nil {
			return
		}
		code := "connection_failed"
		if err != nil {
			code = err.Error()
		}
		if len(code) > 512 {
			code = code[:512]
		}
		s.updateSource(index, func(source *SourceStatus) {
			source.State = "reconnecting"
			source.Collector = nil
			source.LastError = code
			source.Retries++
		})
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		delay = min(delay*2, s.options.MaxReconnectWait)
	}
}

func (s *Store) receive(ctx context.Context, index int, generation uint64, conn *websocket.Conn) (result error) {
	mapper := newMapper()
	var artifact *ArtifactWriter
	var format pb.CaptureFormat
	s.mu.Lock()
	source := s.sources[index]
	session := s.started.UTC().Format(time.RFC3339Nano)
	s.mu.Unlock()
	defer func() {
		if artifact != nil {
			normal := ctx.Err() == nil && websocket.CloseStatus(result) == websocket.StatusNormalClosure
			reason := ""
			if !normal && result != nil {
				reason = result.Error()
			}
			if err := artifact.Finish(normal, reason); err != nil {
				result = err
			}
			s.updateSource(index, func(*SourceStatus) {})
		}
	}()
	reject := func(err error) error {
		s.updateSource(index, func(source *SourceStatus) { source.Malformed++ })
		return err
	}
	for {
		readCtx, cancel := context.WithTimeout(ctx, s.options.ReadTimeout)
		kind, frame, err := conn.Read(readCtx)
		cancel()
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusMessageTooBig || strings.Contains(err.Error(), "read limited") {
				return reject(errors.New("frame_too_large"))
			}
			return err
		}
		if kind != websocket.MessageBinary {
			s.updateSource(index, func(source *SourceStatus) { source.Received++ })
			return reject(errNonBinaryFrame)
		}
		var entry pb.LogEntry
		if err := proto.Unmarshal(frame, &entry); err != nil {
			s.updateSource(index, func(source *SourceStatus) { source.Received++ })
			return reject(fmt.Errorf("protocol_error: malformed protobuf: %w", err))
		}
		if err := validateEntry(&entry); err != nil {
			s.updateSource(index, func(source *SourceStatus) { source.Received++ })
			return reject(fmt.Errorf("protocol_error: %w", err))
		}
		event := entry.GetEventPayload()
		if event != nil {
			if format != pb.CaptureFormat_CAPTURE_FORMAT_UNSPECIFIED && format != event.CaptureFormat {
				s.updateSource(index, func(source *SourceStatus) { source.Received++ })
				return reject(errors.New("protocol_error: capture format changed within connection"))
			}
			format = event.CaptureFormat
			if format != pb.CaptureFormat_CAPTURE_FORMAT_TEXT {
				if artifact == nil {
					name := "keylog"
					if format == pb.CaptureFormat_CAPTURE_FORMAT_PCAPNG {
						name = "pcapng"
					}
					artifact, err = s.artifacts.Begin(session, source.ID, source.Label, entry.Module, name, generation)
					if err != nil {
						return err
					}
				}
				var data []byte
				if format == pb.CaptureFormat_CAPTURE_FORMAT_KEYLOG {
					data = event.GetKeylog().Data
				} else {
					data = event.GetPcapng().Data
				}
				if _, err := artifact.Write(data); err != nil {
					return err
				}
				s.updateSource(index, func(source *SourceStatus) {
					source.Received++
					source.Events++
					source.LastEventAt = time.Now().UTC().Format(time.RFC3339Nano)
				})
				continue
			}
		}
		s.consume(index, generation, &entry, mapper, time.Now())
	}
}

func (s *Store) consume(index int, generation uint64, entry *pb.LogEntry, mapper *eventMapper, now time.Time) {
	s.mu.Lock()
	sourceID := s.sources[index].ID
	s.sources[index].Received++
	s.notifyLocked()
	s.mu.Unlock()
	if err := validateEntry(entry); err != nil {
		s.updateSource(index, func(source *SourceStatus) { source.Malformed++ })
		return
	}
	switch entry.LogType {
	case pb.LogType_LOG_TYPE_HEARTBEAT:
		if entry.GetHeartbeatPayload() == nil {
			s.updateSource(index, func(source *SourceStatus) { source.Malformed++ })
			return
		}
		s.updateSource(index, func(source *SourceStatus) { source.LastHeartbeat = now.UTC().Format(time.RFC3339Nano) })
	case pb.LogType_LOG_TYPE_PROCESS_LOG:
		if _, ok := entry.Payload.(*pb.LogEntry_RunLog); !ok {
			s.updateSource(index, func(source *SourceStatus) { source.Malformed++ })
			return
		}
		message := entry.GetRunLog()
		if collector, recognized := parseCollectorInfo(message); recognized {
			s.mu.Lock()
			if source := &s.sources[index]; source.Generation == generation {
				source.Collector = collector
				if collector == nil {
					source.Malformed++
				}
				s.notifyLocked()
			}
			s.mu.Unlock()
			return
		}
		if len(message) > 4096 {
			message = strings.ToValidUTF8(message[:4096], "�") + "…"
		}
		s.mu.Lock()
		s.logs = append(s.logs, operationalLog{Module: entry.Module, SourceID: sourceID, ReceivedAt: now.UTC().Format(time.RFC3339Nano), Message: message})
		if len(s.logs) > 100 {
			s.logs = append([]operationalLog(nil), s.logs[len(s.logs)-100:]...)
		}
		s.notifyLocked()
		s.mu.Unlock()
	case pb.LogType_LOG_TYPE_EVENT:
		s.ingestMu.Lock()
		defer s.ingestMu.Unlock()
		event := entry.GetEventPayload().GetText()
		if event == nil {
			s.updateSource(index, func(source *SourceStatus) { source.Malformed++ })
			return
		}
		s.updateSource(index, func(source *SourceStatus) { source.Events++; source.LastEventAt = now.UTC().Format(time.RFC3339Nano) })
		mapper.retained = func(record Record) bool {
			// Excluded messages still occupy the HTTP FIFO to suppress their
			// matching responses rather than mispair the next visible request.
			if s.excludeHTTP(record) {
				return true
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			_, ok := s.records[valueString(record["id"])]
			return ok
		}
		for _, record := range mapper.Map(sourceID, generation, event, now, entry.Module) {
			s.upsert(record, event, sourceID)
		}
	default:
		s.updateSource(index, func(source *SourceStatus) { source.Ignored++ })
	}
}

func (s *Store) upsert(record Record, event *pb.TextEvent, sourceID string) {
	// Map before filtering so excluded requests still occupy their correct place
	// in the HTTP/1 queue and HTTP/2 or HTTP/3 stream association.
	if s.excludeHTTP(record) {
		s.mu.Lock()
		s.filtered++
		s.notifyLocked()
		s.mu.Unlock()
		return
	}
	id, _ := record["id"].(string)
	processID, _ := record["processId"].(string)
	data, err := json.Marshal(record)
	if err != nil || id == "" || processID == "" || len(data) > s.options.MaxBytes {
		s.mu.Lock()
		s.dropped++
		s.notifyLocked()
		s.mu.Unlock()
		return
	}
	name, _ := record["processName"].(string)
	if name == "" {
		name = event.Pname
	}
	if name == "" {
		name = "未知进程"
	}
	pid := record["processPid"]
	if pid == nil && event.Pid > 0 {
		pid = event.Pid
	}
	process := processInfo{ID: processID, PID: pid, Name: name, Kind: valueString(record["module"]), Source: sourceID, Command: valueString(record["processCommand"]), CommandTruncated: record["processCommandTruncated"] == true}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, source := range s.sources {
		if process.Kind == "" && source.ID == sourceID && source.Collector != nil {
			process.Kind = source.Collector.Module
		}
	}
	if process.Kind == "" {
		process.Kind = "eCaptureQ"
	}
	if old, exists := s.records[id]; exists {
		s.bytes -= len(old.JSON)
	} else {
		s.order = append(s.order, id)
	}
	var responseProcess *processInfo
	if peer, ok := record["responseProcess"].(processInfo); ok {
		peer.Kind = process.Kind
		responseProcess = &peer
	}
	summary := copyRecord(record)
	for _, key := range []string{"request", "response", "payload", "rawPayload", "responseRawPayload", "processArgs", "responseProcessArgs"} {
		delete(summary, key)
	}
	// Include the service lifetime because record IDs and revisions restart at zero.
	summary["detailVersion"] = fmt.Sprintf("%d:%d", s.started.UnixNano(), s.revision+1)
	hasJSON := false
	if body, ok := record["response"].(map[string]any); ok {
		if headers, ok := body["headers"].([]map[string]string); ok {
			for _, h := range headers {
				if strings.EqualFold(h["name"], "content-type") && strings.Contains(strings.ToLower(h["value"]), "json") {
					hasJSON = true
				}
			}
		}
	} else if record["payloadEncoding"] != "hex" {
		hasJSON = json.Valid([]byte(valueString(record["payload"])))
	}
	s.records[id] = storedRecord{JSON: data, Process: process, ResponseProcess: responseProcess, Summary: summary, HasJSON: hasJSON}
	s.bytes += len(data)
	for len(s.order) > s.options.MaxRecords || s.bytes > s.options.MaxBytes {
		oldest := s.order[0]
		s.order[0] = ""
		s.order = s.order[1:]
		s.bytes -= len(s.records[oldest].JSON)
		delete(s.records, oldest)
		s.evicted++
	}
	s.recordsRevision++
	s.notifyLocked()
}

func (s *Store) excludeHTTP(record Record) bool {
	// Always discard hidden-domain hosts so their traffic is never rendered.
	if isHiddenHost(valueString(record["host"]), s.options.HiddenDomains) {
		return true
	}
	prefix := s.options.ExcludeHTTPPathPrefix
	if prefix == "" || record["family"] != "http" {
		return false
	}
	if target, err := url.ParseRequestURI(valueString(record["path"])); err == nil &&
		(strings.HasPrefix(target.Path, prefix) || target.Path == strings.TrimSuffix(prefix, "/")) {
		return true
	}
	// This marker also covers responses whose request was not observed.
	response, _ := record["response"].(map[string]any)
	headers, _ := response["headers"].([]map[string]string)
	for _, header := range headers {
		if strings.EqualFold(header["name"], "X-Ecaptureq-UI") && header["value"] == "1" {
			return true
		}
	}
	return false
}

func (s *Store) statusLocked() Status {
	status := Status{Artifacts: s.artifacts.List(), State: "unconfigured", Sources: []SourceStatus{}, Logs: append([]operationalLog{}, s.logs...), Dropped: s.dropped, Evicted: s.evicted, Retained: len(s.records), RetainedBytes: s.bytes, MaxRecords: s.options.MaxRecords, MaxBytes: s.options.MaxBytes}
	for _, source := range s.sources {
		if source.ID == "" {
			continue
		}
		source.Collector = source.Collector.clone()
		status.Sources = append(status.Sources, source)
	}
	status.Session = s.started.UTC().Format(time.RFC3339Nano)
	status.Revision, status.RecordsRevision = s.revision, s.recordsRevision
	status.Filtered, status.ExcludeHTTPPathPrefix = s.filtered, s.options.ExcludeHTTPPathPrefix
	status.SourcePersistence = "session"
	if s.options.SourcesFile != "" {
		status.SourcePersistence = "file"
	}
	connected, stopped := 0, 0
	for _, source := range s.sources {
		status.Received += source.Received
		status.Events += source.Events
		status.Malformed += source.Malformed
		status.Ignored += source.Ignored
		if source.LastEventAt > status.LastEventAt {
			status.LastEventAt = source.LastEventAt
		}
		if source.State == "connected" {
			connected++
		}
		if source.State == "stopped" {
			stopped++
		}
	}
	switch {
	case len(status.Sources) == 0:
	case stopped == len(status.Sources):
		status.State = "stopped"
	case connected == len(status.Sources):
		status.State = "connected"
	case connected > 0:
		status.State = "degraded"
	default:
		status.State = "connecting"
		for _, source := range s.sources {
			if source.State == "reconnecting" {
				status.State = "reconnecting"
				break
			}
		}
	}
	return status
}

func (s *Store) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusLocked()
}

func (s *Store) Workspace() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	records := make([]json.RawMessage, 0, len(s.order))
	processes := []processInfo{}
	seen := make(map[string]bool)
	for i := len(s.order) - 1; i >= 0; i-- {
		row := s.records[s.order[i]]
		records = append(records, row.JSON)
		if !seen[row.Process.ID] {
			seen[row.Process.ID] = true
			processes = append(processes, row.Process)
		}
		if peer := row.ResponseProcess; peer != nil && !seen[peer.ID] {
			seen[peer.ID] = true
			processes = append(processes, *peer)
		}
	}
	return map[string]any{"mode": "live", "revision": s.revision, "session": map[string]any{"name": "实时采集", "host": s.host, "mode": "live", "startedAt": s.started.UTC().Format(time.RFC3339Nano)}, "processes": processes, "requests": records, "status": s.statusLocked()}
}

// WorkspacePage filters retained records before paging. Payloads are fetched
// separately so the retention budget does not become a recurring HTTP response.
func (s *Store) WorkspacePage(query url.Values) (map[string]any, error) {
	page := 0
	if value := query.Get("page"); value != "" {
		n, err := strconv.Atoi(value)
		if err != nil || n < 0 || n > 500 {
			return nil, errors.New("invalid_page")
		}
		page = n
	}
	if len(query.Get("q")) > 512 {
		return nil, errors.New("query_too_long")
	}
	pattern := regexp.MustCompile("(?i)" + regexp.QuoteMeta(query.Get("q")))
	s.mu.Lock()
	rows := make([]storedRecord, 0, len(s.order))
	for i := len(s.order) - 1; i >= 0; i-- {
		rows = append(rows, s.records[s.order[i]])
	}
	status, revision, host, started := s.statusLocked(), s.revision, s.host, s.started
	s.mu.Unlock()
	bookmarks := map[string]bool{}
	for _, id := range strings.Split(query.Get("bookmarks"), ",") {
		if id != "" {
			bookmarks[id] = true
		}
	}
	retainedBookmarks := []string{}
	processes := []processInfo{}
	seen := map[string]bool{}
	processCounts, protocolCounts, domains := map[string]int{}, map[string]int{}, map[string]int{}
	matches := []Record{}
	errorsCount := 0
	for _, row := range rows {
		r := row.Summary
		if r == nil {
			continue
		}
		owners := []processInfo{row.Process}
		if row.ResponseProcess != nil {
			owners = append(owners, *row.ResponseProcess)
		}
		for _, owner := range owners {
			if !seen[owner.ID] {
				seen[owner.ID] = true
				processes = append(processes, owner)
			}
		}
		marked := bookmarks[valueString(r["id"])]
		if marked {
			retainedBookmarks = append(retainedBookmarks, valueString(r["id"]))
		}
		scopeOK := query.Get("scope") != "starred" || marked
		processOK := query.Get("process") == ""
		for _, owner := range owners {
			if owner.ID == query.Get("process") {
				processOK = true
			}
		}
		protocol := valueString(r["family"])
		if protocol == "http" && r["protocol"] == "HTTP/3" {
			protocol = "http3"
		}
		protocolOK := query.Get("protocol") == "" || query.Get("protocol") == protocol
		attention := intValue(r["status"]) >= 400 || r["state"] == "failed" || r["state"] == "partial" || r["outcome"] == "error"
		kind := query.Get("filter")
		filterOK := (kind == "" || kind == "all") || (kind == "errors" && attention) || (kind == "pending" && r["state"] == "pending") || (kind == "json" && row.HasJSON)
		otherOK := (query.Get("domain") == "" || query.Get("domain") == valueString(r["host"])) && filterOK && (query.Get("q") == "" || pattern.Match(row.JSON))
		if scopeOK && protocolOK {
			for _, owner := range owners {
				processCounts[owner.ID]++
			}
		}
		if scopeOK && processOK && otherOK {
			protocolCounts[protocol]++
		}
		if scopeOK && processOK && protocolOK {
			domains[valueString(r["host"])]++
			if attention {
				errorsCount++
			}
		}
		if scopeOK && processOK && protocolOK && otherOK {
			matches = append(matches, r)
		}
	}
	const limit = 200
	pages := (len(matches) + limit - 1) / limit
	if page >= pages {
		page = max(0, pages-1)
	}
	start := page * limit
	end := min(start+limit, len(matches))
	return map[string]any{"mode": "live", "revision": revision, "session": map[string]any{"name": "实时采集", "host": host, "mode": "live", "startedAt": started.UTC().Format(time.RFC3339Nano)}, "processes": processes, "requests": matches[start:end], "status": status, "page": map[string]any{"index": page, "size": limit, "total": len(matches), "retained": len(rows), "errors": errorsCount, "processCounts": processCounts, "protocolCounts": protocolCounts, "domains": domains, "bookmarks": retainedBookmarks}}, nil
}

func (s *Store) Record(id string) (json.RawMessage, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row, ok := s.records[id]
	return row.JSON, ok
}
