# Custom SQL Examples for Packet Filtering

The backend processes custom SQL to filter packets. You can provide either a full `SELECT` statement or just the filtering conditions.

The system will append `WHERE index > <last_index>` or `AND index > <last_index>` to your SQL to fetch new packets.

## Guidelines:

-   Your SQL should target the `packets` table.
-   The base table `packets` contains all captured network packet data.
-   Available columns include: `index`, `timestamp`, `uuid`, `src_ip`, `src_port`, `dst_ip`, `dst_port`, `pid`, `pname`, `type`, `length`, `is_binary`, and `payload_utf8`.
-   Use `is_binary = false` to ensure the `payload_utf8` column contains valid UTF-8 text for searching.
-   Avoid using `ORDER BY` or `LIMIT` in your custom SQL, as the system adds its own ordering.

## Examples

### 1. Filter by process name
```sql
pname = 'curl'
```

### 2. Filter for HTTP/HTTPS traffic
```sql
dst_port IN (80, 443)
```

### 3. Filter for packets containing "baidu" in the payload
```sql
is_binary = false AND lower(payload_utf8) LIKE '%baidu%'
```

### 4. Using a full SELECT statement to get DNS packets for "baidu"
```sql
SELECT * FROM packets WHERE type = 53 AND lower(payload_utf8) LIKE '%baidu%'
```

Feel free to adapt these patterns to your environment. After editing the SQL in the settings page, the backend validates it before applying it.

