# Guide to Writing Custom SQL for Packet Filtering

This system supports real-time filtering of captured network packets using standard SQL syntax. To accommodate different user needs, the system provides two modes: **Simple Filtering (Conditions Only)** and **Advanced Query (Full SQL)**.

> **Core Mechanism Explanation**:
> Regardless of the mode used, the system automatically handles **incremental updates**. The logic `WHERE index > last_seen_index` is automatically appended to your SQL base, ensuring you only see the latest packets.

-----

## 1. Table Definition (Schema)

All queries are based on the built-in table `packets`. Below are the available fields and their descriptions:

| Field Name | Type | Description | Example Value |
| :--- | :--- | :--- | :--- |
| `index` | `UInt64` | Globally unique incrementing ID (Primary Key) | `1024` |
| `timestamp` | `Int64` | Capture timestamp (Unix ms) | `1679812345000` |
| `src_ip` | `String` | Source IP Address | `'192.168.1.5'` |
| `src_port` | `UInt32` | Source Port | `54321` |
| `dst_ip` | `String` | Destination IP Address | `'104.16.2.1'` |
| `dst_port` | `UInt32` | Destination Port | `443` |
| `pname` | `String` | Process name initiating the request | `'chrome'`, `'curl'` |
| `pid` | `Int32` | Process ID | `8920` |
| `type` | `UInt32` | Protocol Type (e.g., TCP/UDP identifier) | `6` (TCP), `17` (UDP) |
| `length` | `UInt32` | Total packet length | `1400` |
| `is_binary` | `Bool` | Whether payload is binary data | `false` (Text), `true` (Binary) |
| `payload_utf8`| `String` | Payload content decoded in UTF-8 | `'GET / HTTP/1.1...'` |

-----

## 2. Writing Modes Explained

### Mode A: Simple Filtering Mode (Recommended)

You only need to write the conditional logic that follows the `WHERE` clause. The system automatically completes it to `SELECT ... FROM packets WHERE (...)` and protects your logic priority with parentheses.

* **Applicable Scenario**: Quickly filtering specific IPs, ports, or processes.
* **Input Example**:
  ```sql
  dst_port = 80 AND pname = 'curl'
  ```

### Mode B: Advanced Query Mode (Full SQL)

Write a complete query statement starting with `SELECT`. The system treats your query result as a "temporary view" and performs incremental filtering on top of it.

* **Applicable Scenario**: Users who need `UNION`, complex nested logic, or prefer writing full SQL.
* **Input Example**:
  ```sql
  SELECT * FROM packets WHERE dst_port = 80 UNION SELECT * FROM packets WHERE dst_port = 8080
  ```
* **Note**: Do not include `ORDER BY` or `LIMIT` at the end of the SQL; sorting is managed by the system.

-----

## 3. Practical Examples

### 3.1. Basic Network Filtering

**Scenario: View only HTTP (80) and HTTPS (443) traffic**

```sql
dst_port IN (80, 443)
```

**Scenario: Exclude local loopback traffic (localhost)**

```sql
src_ip != '127.0.0.1' AND dst_ip != '127.0.0.1' AND src_ip != '::1'
```

**Scenario: Filter a specific subnet (simulated via string matching)**

```sql
src_ip LIKE '192.168.1.%'
```

### 3.2. Process & Application Filtering

**Scenario: Track traffic from specific programs (e.g., Python scripts or Browser)**

```sql
pname = 'python' OR pname LIKE 'chrome%'
```

**Scenario: Exclude system noise (e.g., DNS queries)**

```sql
dst_port != 53 AND pname != 'mDNSResponder'
```

### 3.3. Payload Search

> **Performance Tip**: Text search (`LIKE`) is expensive. It is recommended to combine it with `is_binary = false`.

**Scenario: Find sensitive plain-text requests containing "password" or "token"**

```sql
is_binary = false AND (payload_utf8 LIKE '%password%' OR payload_utf8 LIKE '%token%')
```

**Scenario: Find all HTTP GET requests**

```sql
is_binary = false AND payload_utf8 LIKE 'GET %'
```

**Scenario: Find traffic related to a specific domain (e.g., baidu.com)**

```sql
is_binary = false AND payload_utf8 LIKE '%baidu.com%'
```

**Scenario: Find JSON response data**

```sql
is_binary = false AND payload_utf8 LIKE '{%}'
```

### 3.4. Advanced Logic Combinations

**Scenario: Complex "OR" logic (Priority Test)**
*Goal: Find traffic from a specific IP **OR** destined for a specific port, but exclude large packets.*

```sql
(src_ip = '10.0.0.5' OR dst_port = 3306) AND length < 1000
```

*(Note: The system automatically handles the outer parentheses, but adding explicit parentheses is a good habit when mixing OR/AND).*

**Scenario: Data Aggregation using Full SQL (Mode B)**
*Goal: Merge queries from two different conditions.*

```sql
SELECT * FROM packets WHERE pname = 'curl'
UNION
SELECT * FROM packets WHERE pname = 'wget'
```

-----

## 4. Common Errors & Troubleshooting

1. **Do not include `ORDER BY`**

   * ❌ Wrong: `pname = 'curl' ORDER BY timestamp DESC`
   * ✅ Correct: `pname = 'curl'`
   * *Reason: The system must force sorting by `index ASC` to ensure the continuity of the data stream.*

2. **Case Sensitivity**

   * SQL keywords are generally case-insensitive, but string values (e.g., `pname`, `payload_utf8`) are case-sensitive.
   * To search ignoring case, use a function (if supported by the database engine): `lower(pname) = 'curl'`.

3. **Type Matching**

   * `dst_port` is a number, do not use quotes: `dst_port = 80` (✅), `dst_port = '80'` (❌ may cause type conversion errors).