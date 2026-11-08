// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

// Decryptor ConnectionKey.String(): PID-FD-comm/IP:port--IP:port/proto#generation.
// Only this known format is shortened. The upstream UUID, including its endpoint
// order, remains the identity; current message endpoints may be reversed or migrate.
const connectionKey = /^(-?(?:0|[1-9][0-9]{0,18}))-(-?(?:0|[1-9][0-9]{0,18}))-([^\r\n]*)\/([0-9a-fA-F:.]+):([0-9]{1,5})--([0-9a-fA-F:.]+):([0-9]{1,5})\/(tcp|udp)#(0|[1-9][0-9]{0,19})$/;
const minInt64 = -9223372036854775808n, maxInt64 = 9223372036854775807n;
const maxUint64 = 18446744073709551615n;

function validInteger(value) {
  const number = BigInt(value);
  return number >= minInt64 && number <= maxInt64 && number.toString() === value;
}

function endpoint(ip, port) {
  if (Number(port) > 65535 || String(Number(port)) !== port) return null;
  if (ip.includes(':')) {
    // URL parsing validates an IPv6 literal without fetching anything. Preserve
    // its spelling rather than replacing it with URL's canonical representation.
    try { new URL(`http://[${ip}]/`); } catch { return null; }
    return `[${ip}]:${port}`;
  }
  const octets = ip.split('.');
  if (octets.length !== 4 || octets.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) return null;
  return `${ip}:${port}`;
}

export function displayConnectionId(raw) {
  if (typeof raw !== 'string') return raw;
  const match = connectionKey.exec(raw);
  if (!match) return raw;
  const [, pid, fd, , sourceIP, sourcePort, destinationIP, destinationPort, transport, generation] = match;
  if (!validInteger(pid) || !validInteger(fd) || BigInt(generation) > maxUint64) return raw;
  const source = endpoint(sourceIP, sourcePort), destination = endpoint(destinationIP, destinationPort);
  if (!source || !destination) return raw;
  return `${source}--${destination}/${transport}#${generation}`;
}
