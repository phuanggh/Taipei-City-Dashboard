package tools

import (
	"TaipeiCityDashboardBE/app/models"
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// ToolFunc defines the signature for a tool function
type ToolFunc func(ctx context.Context, args string) (string, error)

var registry = make(map[string]ToolFunc)

func init() {
	Register("get_current_time", GetCurrentTime)
	Register("get_population_summary", GetPopulationSummary)
	Register("search_components", SearchComponents)
	Register("get_traffic_accident_stats_by_district", GetTrafficAccidentStatsByDistrict)
}

// Register adds a tool to the registry
func Register(name string, fn ToolFunc) {
	registry[name] = fn
}

// Execute calls a registered tool with the given arguments
func Execute(ctx context.Context, name string, args string) (string, error) {
	fn, ok := registry[name]
	if !ok {
		return "", fmt.Errorf("tool %s not found", name)
	}
	return fn(ctx, args)
}

// PopulationArgs defines the arguments for the get_population_summary tool
type PopulationArgs struct {
	City string `json:"city"`
	Year int    `json:"year"`
}

// GetPopulationSummary queries the population age distribution from the dashboard database
func GetPopulationSummary(ctx context.Context, args string) (string, error) {
	var params PopulationArgs
	if err := parseArgs(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %v", err)
	}

	// Default to Taipei if not specified or unrecognized
	tableName := "population_age_distribution_tpe"
	cityName := "台北市"
	if params.City == "new_taipei" {
		tableName = "population_age_distribution_new_tpe"
		cityName = "新北市"
	}

	// Define result structure based on database schema
	var result struct {
		Year     int       `gorm:"column:year"`
		Young    int       `gorm:"column:young_population"`
		Working  int       `gorm:"column:working_age_population"`
		Elderly  int       `gorm:"column:elderly_population"`
		DataTime time.Time `gorm:"column:data_time"`
	}

	// Query the dashboard database
	err := models.DBDashboard.Table(tableName).
		Where("year = ?", params.Year).
		Order("data_time DESC"). // Get the latest record for that year
		First(&result).Error

	if err != nil {
		return "", fmt.Errorf("找不到 %s %d 年的人口統計資料: %v", cityName, params.Year, err)
	}

	// Format the response for the LLM
	return fmt.Sprintf(
		"【%d年 %s 人口結構概況】\n- 幼年人口 (0-14歲)：%d 人\n- 青壯年人口 (15-64歲)：%d 人\n- 老年人口 (65歲以上)：%d 人\n- 總人口： %d 人\n- 數據更新時間：%s",
		result.Year, cityName, result.Young, result.Working, result.Elderly,
		result.Young+result.Working+result.Elderly,
		result.DataTime.Format("2006-01-02"),
	), nil
}

// GetCurrentTime is a demo tool that returns the current Taipei time
func GetCurrentTime(ctx context.Context, args string) (string, error) {
	loc, err := time.LoadLocation("Asia/Taipei")
	if err != nil {
		// Fallback to UTC if timezone data is missing
		return time.Now().Format(time.RFC3339), nil
	}
	return time.Now().In(loc).Format("2006-01-02 15:04:05"), nil
}

// SearchComponents queries Qdrant for dashboard components semantically similar to the given query.
func SearchComponents(ctx context.Context, args string) (string, error) {
	var params struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := parseArgs(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %v", err)
	}
	if params.Query == "" {
		return "", fmt.Errorf("query is required")
	}
	if params.Limit <= 0 {
		params.Limit = 5
	}

	results, err := models.GetComponentByQueryVector(params.Query, params.Limit, 0.75)
	if err != nil {
		return "", fmt.Errorf("vector search failed: %v", err)
	}
	if len(results) == 0 {
		return "沒有找到與此主題相關的組件。", nil
	}

	out, err := json.Marshal(results)
	if err != nil {
		return "", fmt.Errorf("failed to serialize results: %v", err)
	}
	return string(out), nil
}

// TrafficAccidentStatsArgs defines the arguments for the get_traffic_accident_stats_by_district tool.
type TrafficAccidentStatsArgs struct {
	City string `json:"city"`
}

type trafficAccidentDistrictStat struct {
	CountyName string `gorm:"column:countyname"`
	TownName   string `gorm:"column:townname"`
	Count      int64  `gorm:"column:count"`
}

// GetTrafficAccidentStatsByDistrict counts traffic accident POI records by district.
func GetTrafficAccidentStatsByDistrict(ctx context.Context, args string) (string, error) {
	var params TrafficAccidentStatsArgs
	if args != "" {
		if err := parseArgs(args, &params); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
	}

	countyFilter, scopeName, err := trafficAccidentCountyFilter(params.City)
	if err != nil {
		return "", err
	}

	query := models.DBDashboard.WithContext(ctx).
		Table("poi_tpntp").
		Select("countyname, townname, COUNT(*) AS count").
		Where("townname IS NOT NULL AND townname <> ''")

	if len(countyFilter) > 0 {
		query = query.Where("countyname IN ?", countyFilter)
	} else {
		query = query.Where("countyname IN ?", []string{"臺北市", "新北市"})
	}

	var stats []trafficAccidentDistrictStat
	if err := query.
		Group("countyname, townname").
		Order("countyname ASC, count DESC, townname ASC").
		Scan(&stats).Error; err != nil {
		return "", fmt.Errorf("failed to query traffic accident stats: %v", err)
	}
	if len(stats) == 0 {
		return fmt.Sprintf("找不到%s的交通事故統計資料。", scopeName), nil
	}

	total := int64(0)
	lines := fmt.Sprintf("【%s交通事故統計：各行政區資料筆數】", scopeName)
	currentCounty := ""
	for _, stat := range stats {
		total += stat.Count
		if stat.CountyName != currentCounty {
			currentCounty = stat.CountyName
			lines += fmt.Sprintf("\n\n%s", currentCounty)
		}
		lines += fmt.Sprintf("\n- %s：%d 筆", stat.TownName, stat.Count)
	}
	lines += fmt.Sprintf("\n\n總計：%d 筆", total)
	return lines, nil
}

func trafficAccidentCountyFilter(city string) ([]string, string, error) {
	switch city {
	case "", "both", "雙北", "taipei_new_taipei":
		return []string{"臺北市", "新北市"}, "雙北", nil
	case "taipei", "台北市", "臺北市":
		return []string{"臺北市"}, "臺北市", nil
	case "new_taipei", "新北市":
		return []string{"新北市"}, "新北市", nil
	default:
		return nil, "", fmt.Errorf("city must be taipei, new_taipei, or both")
	}
}

// Helper to parse JSON arguments if needed in future tools
func parseArgs(args string, v interface{}) error {
	return json.Unmarshal([]byte(args), v)
}
