// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package app

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func nativeTestManager(t *testing.T, options NativeOptions) *ArtifactManager {
	t.Helper()
	options.Dir = t.TempDir()
	m, err := NewArtifactManager(options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	return m
}

func syntheticKeylog() []byte {
	return []byte("CLIENT_RANDOM " + strings.Repeat("01", 32) + " " + strings.Repeat("02", 48) + "\n")
}

// SHB + IDB + one explicitly synthetic empty packet + a synthetic NSS DSB.
func syntheticPcapng() []byte {
	var all bytes.Buffer
	block := func(kind uint32, body []byte) {
		for len(body)%4 != 0 {
			body = append(body, 0)
		}
		length := uint32(12 + len(body))
		_ = binary.Write(&all, binary.LittleEndian, kind)
		_ = binary.Write(&all, binary.LittleEndian, length)
		all.Write(body)
		_ = binary.Write(&all, binary.LittleEndian, length)
	}
	shb := make([]byte, 16)
	binary.LittleEndian.PutUint32(shb, 0x1a2b3c4d)
	binary.LittleEndian.PutUint16(shb[4:], 1)
	binary.LittleEndian.PutUint64(shb[8:], ^uint64(0))
	block(0x0a0d0d0a, shb)
	idb := make([]byte, 8)
	binary.LittleEndian.PutUint16(idb, 1)
	binary.LittleEndian.PutUint32(idb[4:], 65535)
	block(1, idb)
	block(6, make([]byte, 20))
	dsb := make([]byte, 8)
	binary.LittleEndian.PutUint32(dsb, 0x544c534b)
	binary.LittleEndian.PutUint32(dsb[4:], uint32(len(syntheticKeylog())))
	block(10, append(dsb, syntheticKeylog()...))
	return all.Bytes()
}

func TestNativeFragmentsCompletionAndIsolation(t *testing.T) {
	m := nativeTestManager(t, NativeOptions{})
	for index, format := range []string{"keylog", "pcapng"} {
		data := syntheticKeylog()
		if format == "pcapng" {
			data = syntheticPcapng()
		}
		writer, err := m.Begin("session", "source-a", "configured label", "unknown-upstream-module", format, uint64(index+1))
		if err != nil {
			t.Fatal(err)
		}
		for offset := 0; offset < len(data); offset += 7 {
			end := min(offset+7, len(data))
			if n, err := writer.Write(data[offset:end]); err != nil || n != end-offset {
				t.Fatalf("write %d %v", n, err)
			}
		}
		before := m.List()[index]
		if before.State != "receiving" || !strings.HasSuffix(before.Filename, ".partial") {
			t.Fatal(before)
		}
		if err := writer.Finish(true, ""); err != nil {
			t.Fatal(err)
		}
		info := m.List()[index]
		if info.State != "complete" || info.Bytes != int64(len(data)) || info.Module != "unknown-upstream-module" || info.SourceLabel != "configured label" || info.Generation != uint64(index+1) || strings.HasSuffix(info.Filename, ".partial") {
			t.Fatal(info)
		}
		reader, err := m.Open("session", info.ID)
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(reader)
		_ = reader.Close()
		if err != nil || !bytes.Equal(got, data) {
			t.Fatalf("native bytes changed: %v", err)
		}
		st, err := os.Stat(writer.path)
		if err != nil || !st.Mode().IsRegular() {
			t.Fatalf("artifact file: %v %v", st, err)
		}
		// Windows FileMode does not expose POSIX permission bits or NTFS ACLs.
		if runtime.GOOS != "windows" && st.Mode().Perm() != 0600 {
			t.Fatalf("file permissions: %v %v", st, err)
		}
	}
	items := m.List()
	if items[0].ID == items[1].ID || items[0].Filename == items[1].Filename {
		t.Fatal("generations reused file")
	}
	st, err := os.Stat(m.dir)
	if err != nil || !st.IsDir() {
		t.Fatalf("artifact directory: %v %v", st, err)
	}
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0700 {
		t.Fatalf("directory permissions: %v %v", st, err)
	}
	for _, tc := range []struct{ session, id string }{{"other", items[0].ID}, {"", items[0].ID}, {"session", "../file"}, {"session", strings.Repeat("f", 32)}} {
		if reader, err := m.Open(tc.session, tc.id); err == nil {
			reader.Close()
			t.Fatalf("opened unowned id: %+v", tc)
		}
	}
}

func TestNativeInterruptedOrInvalidNeverCompletes(t *testing.T) {
	for _, tc := range []struct {
		name, format string
		data         []byte
		normal       bool
		state        string
	}{
		{"normal", "keylog", syntheticKeylog(), true, "complete"},
		{"1011", "keylog", syntheticKeylog(), false, "partial"},
		{"eof", "pcapng", syntheticPcapng(), false, "partial"},
		{"cancel", "pcapng", syntheticPcapng(), false, "partial"},
		{"unterminated line", "keylog", bytes.TrimSuffix(syntheticKeylog(), []byte("\n")), true, "failed"},
		{"invalid label", "keylog", bytes.ReplaceAll(syntheticKeylog(), []byte("CLIENT_RANDOM"), []byte("FAKE")), true, "failed"},
		{"truncated block", "pcapng", syntheticPcapng()[:47], true, "failed"},
		{"envelope", "pcapng", []byte("not pcapng"), true, "failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := nativeTestManager(t, NativeOptions{})
			a, _ := m.Begin("session", "source", "", "tls", tc.format, 1)
			_, _ = a.Write(tc.data)
			_ = a.Finish(tc.normal, tc.name)
			info := m.List()[0]
			if info.State != tc.state || (info.State != "complete" && !strings.HasSuffix(info.Filename, ".partial")) {
				t.Fatal(info)
			}
			if info.State != "complete" && info.Error == "" {
				t.Fatal("missing failure explanation")
			}
		})
	}
}

type faultyNativeFile struct {
	syncedWriter
	write, sync, close bool
}

func (f faultyNativeFile) Write(data []byte) (int, error) {
	if f.write {
		return 0, errors.New("disk full /private/path")
	}
	return f.syncedWriter.Write(data)
}
func (f faultyNativeFile) Sync() error {
	if f.sync {
		return errors.New("flush failed /private/path")
	}
	return f.syncedWriter.Sync()
}
func (f faultyNativeFile) Close() error {
	err := f.syncedWriter.Close()
	if f.close {
		return errors.New("close failed /private/path")
	}
	return err
}

func TestNativeDiskFailuresKeepPartialAndDoNotLeakPaths(t *testing.T) {
	for _, phase := range []string{"write", "sync", "close", "rename"} {
		t.Run(phase, func(t *testing.T) {
			m := nativeTestManager(t, NativeOptions{})
			a, _ := m.Begin("s", "source", "", "tls", "keylog", 1)
			a.file = faultyNativeFile{syncedWriter: a.file, write: phase == "write", sync: phase == "sync", close: phase == "close"}
			_, _ = a.Write(syntheticKeylog())
			if phase == "rename" {
				if err := os.WriteFile(strings.TrimSuffix(a.path, ".partial"), []byte("user file"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := a.Finish(true, ""); err == nil {
				t.Fatal("accepted local file failure")
			}
			info := m.List()[0]
			if info.State != "failed" || !strings.HasSuffix(info.Filename, ".partial") || strings.Contains(info.Error, "private") {
				t.Fatal(info)
			}
			if phase == "rename" {
				got, _ := os.ReadFile(strings.TrimSuffix(a.path, ".partial"))
				if string(got) != "user file" {
					t.Fatal("overwrote destination")
				}
			}
		})
	}
}

func TestNativeBoundsAndLeasedDownloads(t *testing.T) {
	m := nativeTestManager(t, NativeOptions{MaxBytes: int64(len(syntheticKeylog())), MaxSessions: 1})
	a, _ := m.Begin("s", "source", "", "tls", "keylog", 1)
	_, _ = a.Write(syntheticKeylog())
	if _, err := a.Write([]byte("x")); !errors.Is(err, ErrNativeLimit) {
		t.Fatalf("limit: %v", err)
	}
	_ = a.Finish(true, "")
	info := m.List()[0]
	if info.State != "failed" || info.Error != "native_storage_limit" {
		t.Fatal(info)
	}
	r, err := m.Open("s", info.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Begin("s", "source", "", "tls", "keylog", 2); !errors.Is(err, ErrNativeLimit) {
		t.Fatalf("evicted leased file: %v", err)
	}
	_ = r.Close()
	b, err := m.Begin("s", "source", "", "tls", "keylog", 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Open("s", info.ID); !errors.Is(err, ErrArtifactNotFound) {
		t.Fatal("evicted file remained visible")
	}
	if len(m.List()) != 1 || m.List()[0].Generation != 2 {
		t.Fatal(m.List())
	}
	_, _ = b.Write(syntheticKeylog())
	_ = b.Finish(true, "")
}

func TestNativeDownloadIsSnapshotAndExportSurvivesCleanup(t *testing.T) {
	m := nativeTestManager(t, NativeOptions{})
	a, _ := m.Begin("s", "source", "", "tls", "keylog", 1)
	data := syntheticKeylog()
	_, _ = a.Write(data[:7])
	r, err := m.Open("s", m.List()[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = a.Write(data[7:])
	got, _ := io.ReadAll(r)
	if !bytes.Equal(got, data[:7]) || r.Info.State != "receiving" || !strings.HasSuffix(r.Info.Filename, ".partial") {
		t.Fatal("download grew with writer")
	}
	_ = r.Close()
	_ = a.Finish(true, "")
	r, err = m.Open("s", m.List()[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	exported := filepath.Join(t.TempDir(), "user.keylog")
	f, _ := os.Create(exported)
	_, err = io.Copy(f, r)
	_ = f.Close()
	if err != nil {
		t.Fatal(err)
	}
	_ = m.Close()
	if _, err := os.Stat(m.dir); err != nil {
		t.Fatal("cleaned leased files before download closed")
	}
	_ = r.Close()
	if _, err := os.Stat(m.dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("private directory leaked")
	}
	got, err = os.ReadFile(exported)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("cleanup touched user export")
	}
}

func TestNativeCompletionKeepsActiveDownloadSnapshot(t *testing.T) {
	for _, format := range []string{"keylog", "pcapng"} {
		t.Run(format, func(t *testing.T) {
			m := nativeTestManager(t, NativeOptions{})
			a, err := m.Begin("s", "source", "", "tls", format, 1)
			if err != nil {
				t.Fatal(err)
			}
			data := syntheticKeylog()
			if format == "pcapng" {
				data = syntheticPcapng()
			}
			if _, err := a.Write(data[:7]); err != nil {
				t.Fatal(err)
			}
			snapshot, err := m.Open("s", m.List()[0].ID)
			if err != nil {
				t.Fatal(err)
			}
			defer snapshot.Close()
			if _, err := a.Write(data[7:]); err != nil {
				t.Fatal(err)
			}
			if err := a.Finish(true, ""); err != nil {
				t.Fatalf("active download prevented completion: %v", err)
			}
			info := m.List()[0]
			if info.State != "complete" || strings.HasSuffix(info.Filename, ".partial") {
				t.Fatal(info)
			}
			got, err := io.ReadAll(snapshot)
			if err != nil || !bytes.Equal(got, data[:7]) || snapshot.Info.State != "receiving" {
				t.Fatalf("completion changed active snapshot: %q %v", got, err)
			}
			complete, err := m.Open("s", info.ID)
			if err != nil {
				t.Fatal(err)
			}
			defer complete.Close()
			got, err = io.ReadAll(complete)
			if err != nil || !bytes.Equal(got, data) {
				t.Fatalf("completed file bytes: %q %v", got, err)
			}
		})
	}
}

func TestPcapngValidatesByteOrderSectionsPacketsAndOptions(t *testing.T) {
	var big bytes.Buffer
	for _, value := range []uint32{0x0a0d0d0a, 28, 0x1a2b3c4d, 1 << 16, 0xffffffff, 0xffffffff, 28, 1, 20, 1 << 16, 65535, 20} {
		_ = binary.Write(&big, binary.BigEndian, value)
	}
	if err := validatePcapng(bytes.NewReader(big.Bytes())); err != nil {
		t.Fatal("big endian section", err)
	}
	if err := validatePcapng(bytes.NewReader(append(syntheticPcapng(), big.Bytes()...))); err != nil {
		t.Fatal("mixed sections", err)
	}
	withOptions := append([]byte(nil), syntheticPcapng()[:44]...)
	withOptions = append(withOptions, 1, 0, 1, 0, 'x', 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0)
	withOptions = append(withOptions, syntheticPcapng()[48:]...)
	binary.LittleEndian.PutUint32(withOptions[32:36], 32)
	if err := validatePcapng(bytes.NewReader(withOptions)); err != nil {
		t.Fatal("valid options", err)
	}
	for _, tc := range []struct {
		name   string
		data   []byte
		mutate func([]byte)
	}{
		{"trailer", syntheticPcapng(), func(b []byte) { b[len(b)-1] ^= 1 }},
		{"missing interface", syntheticPcapng(), func(b []byte) { binary.LittleEndian.PutUint32(b[56:60], 1) }},
		{"packet length", syntheticPcapng(), func(b []byte) { binary.LittleEndian.PutUint32(b[68:72], 1) }},
		{"interface reserved", syntheticPcapng(), func(b []byte) { b[38] = 1 }},
		{"option length", withOptions, func(b []byte) { binary.LittleEndian.PutUint16(b[46:48], 50) }},
		{"section length", syntheticPcapng(), func(b []byte) { binary.LittleEndian.PutUint64(b[16:24], 4) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := append([]byte(nil), tc.data...)
			tc.mutate(data)
			if err := validatePcapng(bytes.NewReader(data)); err == nil {
				t.Fatal("invalid native format accepted")
			}
		})
	}
}
