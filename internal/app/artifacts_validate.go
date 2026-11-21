// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package app

import (
	"bufio"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
)

var nssLabel = regexp.MustCompile(`^(CLIENT_RANDOM|CLIENT_EARLY_TRAFFIC_SECRET|EARLY_EXPORTER_SECRET|CLIENT_HANDSHAKE_TRAFFIC_SECRET|SERVER_HANDSHAKE_TRAFFIC_SECRET|CLIENT_TRAFFIC_SECRET_[0-9]+|SERVER_TRAFFIC_SECRET_[0-9]+|EXPORTER_SECRET)$`)

func validateKeylog(input io.Reader) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 64<<10)
	scanner.Split(func(data []byte, eof bool) (int, []byte, error) {
		if eof && len(data) != 0 && data[len(data)-1] != '\n' {
			return 0, nil, errors.New("unterminated NSS record")
		}
		return bufio.ScanLines(data, eof)
	})
	records := 0
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 3 || !nssLabel.MatchString(fields[0]) {
			return errors.New("invalid NSS record")
		}
		random, er := hex.DecodeString(fields[1])
		secret, es := hex.DecodeString(fields[2])
		if er != nil || es != nil || len(random) != 32 || len(secret) < 16 {
			return errors.New("invalid NSS fields")
		}
		records++
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if records == 0 {
		return errors.New("no NSS records")
	}
	return nil
}

// Validation is streaming and independent of WebSocket message boundaries. It
// checks framing and references, not decryption or capture completeness.
func validatePcapng(input io.Reader) error {
	var order binary.ByteOrder
	var header [12]byte
	var extra [16]byte
	var interfaces uint32
	var snaplens []uint32
	sectionRemaining := int64(-1)
	sections, descriptions := 0, 0
	for {
		_, err := io.ReadFull(input, header[:])
		if err == io.EOF {
			break
		}
		if err != nil {
			return errors.New("truncated pcapng header")
		}
		section := binary.BigEndian.Uint32(header[:4]) == 0x0a0d0d0a
		if section {
			if order != nil && sectionRemaining > 0 {
				return errors.New("incomplete pcapng section")
			}
			switch binary.BigEndian.Uint32(header[8:]) {
			case 0x1a2b3c4d:
				order = binary.BigEndian
			case 0x4d3c2b1a:
				order = binary.LittleEndian
			default:
				return errors.New("invalid pcapng byte order")
			}
			interfaces = 0
			snaplens = nil
			sections++
		}
		if order == nil {
			return errors.New("missing pcapng section header")
		}
		kind, length := order.Uint32(header[:4]), order.Uint32(header[4:8])
		minimum, readExtra := uint32(12), 0
		switch kind {
		case 0x0a0d0d0a:
			minimum, readExtra = 28, 12
		case 1:
			minimum, readExtra = 20, 4
		case 6:
			minimum, readExtra = 32, 16
		case 3:
			minimum = 16
		case 0x0000000a:
			minimum, readExtra = 20, 4
		}
		if length < minimum || length%4 != 0 || length > 64<<20 {
			return fmt.Errorf("invalid pcapng block length")
		}
		if !section && sectionRemaining >= 0 {
			if int64(length) > sectionRemaining {
				return errors.New("pcapng section length exceeded")
			}
			sectionRemaining -= int64(length)
		}
		if length == 12 {
			if order.Uint32(header[8:]) != length {
				return errors.New("pcapng trailer mismatch")
			}
			continue
		}
		if readExtra != 0 {
			if _, err := io.ReadFull(input, extra[:readExtra]); err != nil {
				return errors.New("truncated pcapng body")
			}
		}
		switch kind {
		case 0x0a0d0d0a:
			if order.Uint16(extra[:2]) != 1 {
				return errors.New("unsupported pcapng version")
			}
			sectionBytes := order.Uint64(extra[4:12])
			sectionRemaining = -1
			if sectionBytes != ^uint64(0) {
				if sectionBytes > 1<<63-1 || sectionBytes%4 != 0 {
					return errors.New("invalid pcapng section length")
				}
				sectionRemaining = int64(sectionBytes)
			}
		case 1:
			interfaces++
			descriptions++
			if interfaces > 65536 {
				return errors.New("pcapng interface limit")
			}
			if order.Uint16(header[10:12]) != 0 {
				return errors.New("invalid pcapng interface reserved field")
			}
			snaplens = append(snaplens, order.Uint32(extra[:4]))
		case 6:
			captured, original := order.Uint32(extra[8:12]), order.Uint32(extra[12:16])
			iface := order.Uint32(header[8:12])
			if iface >= interfaces || captured > original || uint64(captured)+uint64((4-captured%4)%4) > uint64(length-32) {
				return errors.New("invalid pcapng packet")
			}
			if snaplens[iface] != 0 && captured > snaplens[iface] {
				return errors.New("pcapng packet exceeds snaplen")
			}
		case 3:
			if interfaces == 0 {
				return errors.New("pcapng packet has no interface")
			}
			captured := order.Uint32(header[8:12])
			if snaplens[0] != 0 {
				captured = min(captured, snaplens[0])
			}
			if uint64(captured)+uint64((4-captured%4)%4) != uint64(length-16) {
				return errors.New("invalid pcapng simple packet length")
			}
		case 0x0000000a:
			secretBytes := order.Uint32(extra[:4])
			if uint64(secretBytes)+uint64((4-secretBytes%4)%4) > uint64(length-20) {
				return errors.New("invalid pcapng secrets block")
			}
		}
		remaining := int64(length) - 16 - int64(readExtra)
		optionBytes := int64(-1)
		switch kind {
		case 0x0a0d0d0a, 1:
			optionBytes = remaining
		case 6:
			captured := uint64(order.Uint32(extra[8:12]))
			optionBytes = remaining - int64((captured+3)&^3)
		case 10:
			secretBytes := uint64(order.Uint32(extra[:4]))
			optionBytes = remaining - int64((secretBytes+3)&^3)
		}
		if optionBytes >= 0 {
			if _, err := io.CopyN(io.Discard, input, remaining-optionBytes); err != nil {
				return errors.New("truncated pcapng data")
			}
			if err := validatePcapngOptions(input, order, optionBytes); err != nil {
				return err
			}
		} else if _, err := io.CopyN(io.Discard, input, remaining); err != nil {
			return errors.New("truncated pcapng body")
		}
		var trailer [4]byte
		if _, err := io.ReadFull(input, trailer[:]); err != nil || order.Uint32(trailer[:]) != length {
			return errors.New("pcapng trailer mismatch")
		}
	}
	if sections == 0 || descriptions == 0 {
		return errors.New("missing pcapng headers")
	}
	if sectionRemaining > 0 {
		return errors.New("incomplete pcapng section")
	}
	return nil
}

func validatePcapngOptions(input io.Reader, order binary.ByteOrder, remaining int64) error {
	var header [4]byte
	for remaining > 0 {
		if remaining < 4 {
			return errors.New("invalid pcapng options")
		}
		if _, err := io.ReadFull(input, header[:]); err != nil {
			return errors.New("truncated pcapng options")
		}
		remaining -= 4
		code, length := order.Uint16(header[:2]), order.Uint16(header[2:])
		if code == 0 {
			if length != 0 || remaining != 0 {
				return errors.New("invalid pcapng option terminator")
			}
			return nil
		}
		padded := (int64(length) + 3) &^ 3
		if padded > remaining {
			return errors.New("pcapng option exceeds block")
		}
		if _, err := io.CopyN(io.Discard, input, padded); err != nil {
			return errors.New("truncated pcapng option value")
		}
		remaining -= padded
	}
	return nil
}
