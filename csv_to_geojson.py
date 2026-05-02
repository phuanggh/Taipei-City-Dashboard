#!/usr/bin/env python3
import argparse
import csv
import json
from pathlib import Path
from typing import Dict, Iterable, Tuple

LON_CANDIDATES = ["lng", "lon", "longitude", "x"]
LAT_CANDIDATES = ["lat", "latitude", "y"]


def find_coord_fields(fieldnames: Iterable[str]) -> Tuple[str, str]:
    name_map = {name.lower().strip(): name for name in fieldnames}

    lon_field = next((name_map[k] for k in LON_CANDIDATES if k in name_map), None)
    lat_field = next((name_map[k] for k in LAT_CANDIDATES if k in name_map), None)

    if not lon_field or not lat_field:
        raise ValueError(
            f"Cannot find coordinate fields. Expected lon in {LON_CANDIDATES}, lat in {LAT_CANDIDATES}."
        )

    return lon_field, lat_field


def row_to_feature(row: Dict[str, str], lon_field: str, lat_field: str):
    try:
        lon = float(row[lon_field])
        lat = float(row[lat_field])
    except (TypeError, ValueError):
        return None

    properties = {k: v for k, v in row.items() if k not in (lon_field, lat_field)}

    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": properties,
    }


def convert_csv_to_geojson(csv_path: Path, output_path: Path, encoding: str = "utf-8-sig"):
    with csv_path.open("r", encoding=encoding, newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            raise ValueError("CSV has no header.")

        lon_field, lat_field = find_coord_fields(reader.fieldnames)

        features = []
        skipped = 0
        for row in reader:
            feature = row_to_feature(row, lon_field, lat_field)
            if feature is None:
                skipped += 1
                continue
            features.append(feature)

    geojson = {"type": "FeatureCollection", "features": features}

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False, indent=2)

    return len(features), skipped, lon_field, lat_field


def main():
    parser = argparse.ArgumentParser(description="Convert CSV files with coordinates into GeoJSON.")
    parser.add_argument("--input-dir", default="data_2026", help="Directory containing CSV files.")
    parser.add_argument("--output-dir", default="data_2026_geojson", help="Directory for GeoJSON output.")
    parser.add_argument("--encoding", default="utf-8-sig", help="CSV file encoding (default: utf-8-sig).")
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)

    if not input_dir.exists() or not input_dir.is_dir():
        raise SystemExit(f"Input directory does not exist: {input_dir}")

    csv_files = sorted(input_dir.glob("*.csv"))
    if not csv_files:
        raise SystemExit(f"No CSV files found in {input_dir}")

    for csv_file in csv_files:
        out_file = output_dir / f"{csv_file.stem}.geojson"
        try:
            features, skipped, lon_field, lat_field = convert_csv_to_geojson(
                csv_file, out_file, encoding=args.encoding
            )
            print(
                f"[OK] {csv_file.name} -> {out_file} | features={features}, skipped={skipped}, lon={lon_field}, lat={lat_field}"
            )
        except Exception as e:
            print(f"[FAIL] {csv_file.name}: {e}")


if __name__ == "__main__":
    main()
