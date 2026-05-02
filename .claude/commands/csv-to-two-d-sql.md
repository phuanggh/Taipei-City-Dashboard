# csv-to-two-d-sql

將指定的 CSV 檔轉換為 Dashboard two_d 格式所需的 PostgreSQL 查詢語法。

## two_d 格式說明

輸出格式為 flat table，兩欄：

| x_axis | data |
|--------|------|
| 類別A  | 123  |
| 類別B  | 456  |

對應 Dashboard two_d JSON 的 `{"x": ..., "y": ...}`，支援 DonutChart、BarChart、ColumnChart 等圖表。

## 執行步驟

使用者說要把某個 CSV 組成 two_d 用的 SQL 時，依照以下步驟執行：

### 1. 讀取 CSV 結構

用 Bash 工具執行：
```bash
head -3 <csv路徑>
```
取得欄位名稱與資料範例。

### 2. 分析欄位

判斷哪個欄位適合作為 `x_axis`（分類維度），哪個欄位適合作為 `data`（數值）：

- **x_axis**：通常是文字類別欄位（如 category、subcategory、direction、type、district）
- **data**：優先使用現有數值欄位（如 `sum(某數值欄位)`）；若無明顯數值欄，用 `COUNT(*)` 計算筆數

若有多個候選 x_axis，以子類別（subcategory）優先，主類別次之。

### 3. 檢查髒資料

用 Bash 執行：
```bash
cut -d',' -f<x_axis欄位索引> <csv路徑> | sort | uniq -c | sort -rn | head -20
```
找出需要過濾的異常值（空值、地址混入類別欄等）。

### 4. 產生 SQL

輸出格式固定對齊以下結構（參考 bike_network 的正確模式）：

```sql
SELECT x_axis, sum(data) AS data
FROM (
  SELECT <x_axis欄位> AS x_axis, <計算方式> AS data
  FROM public.<資料表名稱>
  <WHERE 過濾髒資料（若有）>
  GROUP BY <x_axis欄位>
) d
WHERE x_axis != ''
GROUP BY x_axis
ORDER BY data DESC;
```

- 資料表名稱：若 CSV 尚未匯入，一併附上建表與 COPY 語法
- 若需要合併多個來源（多張表或多個欄位維度），用 `UNION ALL` 包在 subquery 內，外層再 `GROUP BY x_axis`

### 5. 附上建表語法（若需要）

```sql
CREATE TABLE public.<資料表名稱> (
  <欄位名稱> <型別>,
  ...
);

COPY public.<資料表名稱> FROM '<csv絕對路徑>'
  CSV HEADER ENCODING 'UTF8';
```

## 範例輸出

以 `streetside_osm.csv`（欄位：id, name, address, category, subcategory, weight, source, city, lng, lat）為例：

```sql
SELECT x_axis, sum(data) AS data
FROM (
  SELECT subcategory AS x_axis, COUNT(*) AS data
  FROM public.streetside_osm
  WHERE category IN ('餐飲', '零售', '上下客')
  GROUP BY subcategory
) d
WHERE x_axis != ''
GROUP BY x_axis
ORDER BY data DESC;
```

## 注意事項

- 數值欄位有單位換算需求時（如 cycling_length 換算 km）在 subquery 內處理：`round(sum(欄位)/1000)`
- 過濾條件優先用 `IN (...)` 列出合法類別值，而非只過濾空字串
- 若 CSV 欄位含逗號（地址欄常見），建議改用 `\t` 分隔或確認 quote 處理
