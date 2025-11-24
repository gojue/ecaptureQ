# 自定义数据包过滤 SQL 编写指南

本系统支持使用标准 SQL 语法对捕获的网络数据包进行实时过滤。为了满足不同用户的需求，系统提供了\*\*简易过滤（仅条件）**和**高级查询（完整 SQL）\*\*两种模式。

> **核心机制说明**：
> 无论使用何种模式，系统都会自动处理**增量更新**。系统会在您的 SQL 基础之上自动追加 `WHERE index > last_seen_index` 逻辑，确保您只看到最新的数据包。

-----

## 1\. 数据表定义 (Schema)

所有查询均基于内置表 `packets`。以下是可用字段及其说明：

| 字段名 | 类型 | 说明 | 示例值 |
| :--- | :--- | :--- | :--- |
| `index` | `UInt64` | 全局唯一递增 ID (主键) | `1024` |
| `timestamp` | `Int64` | 捕获时间戳 (Unix ms) | `1679812345000` |
| `src_ip` | `String` | 源 IP 地址 | `'192.168.1.5'` |
| `src_port` | `UInt32` | 源端口 | `54321` |
| `dst_ip` | `String` | 目标 IP 地址 | `'104.16.2.1'` |
| `dst_port` | `UInt32` | 目标端口 | `443` |
| `pname` | `String` | 发起请求的进程名称 | `'chrome'`, `'curl'` |
| `pid` | `Int32` | 进程 ID | `8920` |
| `type` | `UInt32` | 协议类型 (如 TCP/UDP 标识) | `6` (TCP), `17` (UDP) |
| `length` | `UInt32` | 数据包总长度 | `1400` |
| `is_binary` | `Bool` | 载荷是否为二进制数据 | `false` (文本), `true` (二进制) |
| `payload_utf8`| `String` | UTF-8 解码后的载荷内容 | `'GET / HTTP/1.1...'` |

-----

## 2\. 编写模式说明

### 模式 A：简易过滤模式 (推荐)

仅需编写 `WHERE` 子句之后的条件逻辑。系统会自动补全 `SELECT ... FROM packets WHERE (...)` 并通过括号保护您的逻辑优先级。

  * **适用场景**：快速筛选特定 IP、端口或进程。
  * **输入示例**：
    ```sql
    dst_port = 80 AND pname = 'curl'
    ```

### 模式 B：高级查询模式 (完整 SQL)

编写以 `SELECT` 开头的完整查询语句。系统会将您的查询结果视为一张“临时视图”，在此基础上进行增量过滤。

  * **适用场景**：需要使用 `UNION`、复杂的嵌套逻辑，或习惯编写完整 SQL 的用户。
  * **输入示例**：
    ```sql
    SELECT * FROM packets WHERE dst_port = 80 UNION SELECT * FROM packets WHERE dst_port = 8080
    ```
  * **注意**：请勿在 SQL 末尾包含 `ORDER BY` 或 `LIMIT`，排序由系统接管。

-----

## 3\. 丰富的实战用例 (Examples)

### 3.1. 基础网络筛选

**场景：只查看 HTTP (80) 和 HTTPS (443) 流量**

```sql
dst_port IN (80, 443)
```

**场景：排除本地回环流量 (localhost)**

```sql
src_ip != '127.0.0.1' AND dst_ip != '127.0.0.1' AND src_ip != '::1'
```

**场景：筛选特定网段 (通过字符串匹配模拟)**

```sql
src_ip LIKE '192.168.1.%'
```

### 3.2. 进程与应用筛选

**场景：追踪特定程序的流量 (如 Python 脚本或浏览器)**

```sql
pname = 'python' OR pname LIKE 'chrome%'
```

**场景：排除系统噪音 (如 DNS 查询)**

```sql
dst_port != 53 AND pname != 'mDNSResponder'
```

### 3.3. 载荷内容搜索 (Payload Search)

> **性能提示**：文本搜索 (`LIKE`) 开销较大，建议配合 `is_binary = false` 使用。

**场景：查找包含 "password" 或 "token" 的敏感明文请求**

```sql
is_binary = false AND (payload_utf8 LIKE '%password%' OR payload_utf8 LIKE '%token%')
```

**场景：查找所有 HTTP GET 请求**

```sql
is_binary = false AND payload_utf8 LIKE 'GET %'
```

**场景：查找特定域名 (如 baidu.com) 的相关流量**

```sql
is_binary = false AND payload_utf8 LIKE '%baidu.com%'
```

**场景：查找 JSON 响应数据**

```sql
is_binary = false AND payload_utf8 LIKE '{%}'
```

### 3.4. 高级逻辑组合

**场景：复杂的“或者”逻辑 (优先级测试)**
*目的：查找来自特定 IP **或者** 目标是特定端口的流量，但必须排除大包。*

```sql
(src_ip = '10.0.0.5' OR dst_port = 3306) AND length < 1000
```

*(注：系统会自动处理外层括号，但在混合 OR/AND 时，显式添加括号是好习惯)*

**场景：使用完整 SQL 进行数据聚合 (模式 B)**
*目的：将两个不同条件的查询合并。*

```sql
SELECT * FROM packets WHERE pname = 'curl'
UNION
SELECT * FROM packets WHERE pname = 'wget'
```

-----

## 4\. 常见错误与排查

1.  **不要包含 `ORDER BY`**

      * ❌ 错误：`pname = 'curl' ORDER BY timestamp DESC`
      * ✅ 正确：`pname = 'curl'`
      * *原因：系统必须强制按 `index ASC` 排序以保证数据流的连续性。*

2.  **区分大小写**

      * SQL 关键字通常不区分大小写，但字符串值 (如 `pname`, `payload_utf8`) 是区分大小写的。
      * 如需忽略大小写搜索，请使用函数 (如果数据库引擎支持)：`lower(pname) = 'curl'`。

3.  **类型匹配**

      * `dst_port` 是数字，不要加引号：`dst_port = 80` (✅), `dst_port = '80'` (❌ 可能导致类型转换错误)。
