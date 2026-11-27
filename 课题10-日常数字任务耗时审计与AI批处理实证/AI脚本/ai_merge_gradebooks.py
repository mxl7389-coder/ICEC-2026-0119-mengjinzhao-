#!/usr/bin/env python3
"""Merge 10 heterogeneous class gradebooks and validate the result.

Dependencies: Python 3.10+ and openpyxl.
The script uses relative paths, so it can be rerun from the submission root:

    python "AI脚本/ai_merge_gradebooks.py"
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import time
from pathlib import Path

from openpyxl import load_workbook


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "任务样本"
DEFAULT_OUTPUT = ROOT / "AI输出"
EXPECTED = {
    "classes": 10,
    "records": 102,
    "unique_student_ids": 102,
    "valid_scores": 96,
    "text_missing": 3,
    "out_of_range": 3,
    "needs_review": 7,
}


def text_value(value) -> str:
    return "" if value is None else str(value).strip()


def clean_name(value) -> str:
    return re.sub(r"\s+", "", text_value(value))


def normalize_student_id(raw_id, class_number: int) -> tuple[str, bool]:
    raw = text_value(raw_id)
    if re.fullmatch(r"2025\d{5}", raw):
        return raw, False
    digits = re.sub(r"\D", "", raw)
    if not digits:
        return raw, False
    normalized = f"2025{class_number:02d}{int(digits):03d}"
    return normalized, normalized != raw


def classify_score(score) -> str:
    if isinstance(score, (int, float)) and not isinstance(score, bool):
        return "valid" if 0 <= score <= 100 else "out_of_range"
    return "text_missing"


def read_header(sheet) -> tuple[bool, dict[str, int]]:
    first_row = [
        text_value(sheet.cell(1, column).value)
        for column in range(1, sheet.max_column + 1)
    ]
    has_header = "姓名" in first_row
    if has_header:
        return True, {
            value: index
            for index, value in enumerate(first_row)
            if value
        }
    return False, {"姓名": 0, "学号": 1, "成绩": 2, "备注": 3}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    records = []
    class_rows = []
    per_file_times = []
    started_all = time.perf_counter()
    cumulative_ai = 0.0

    for class_number in range(1, 11):
        source = args.source / f"{class_number}班.xlsx"
        if not source.exists():
            raise FileNotFoundError(source)
        started_file = time.perf_counter()
        workbook = load_workbook(source, data_only=True, read_only=False)
        sheet = workbook[workbook.sheetnames[0]]
        has_header, header_map = read_header(sheet)
        remark_column = "备注" in header_map
        raw_rows = 0
        blank_rows = 0
        merged_rows = 0

        for row_number in range(2 if has_header else 1, sheet.max_row + 1):
            values = [
                sheet.cell(row_number, column).value
                for column in range(1, sheet.max_column + 1)
            ]
            if all(text_value(value) == "" for value in values):
                blank_rows += 1
                continue
            raw_rows += 1
            name_raw = values[header_map["姓名"]]
            score = values[header_map["成绩"]]
            remark = (
                values[header_map["备注"]]
                if remark_column and header_map["备注"] < len(values)
                else ""
            )
            name = clean_name(name_raw)
            student_id, completed = normalize_student_id(
                values[header_map["学号"]], class_number
            )
            score_kind = classify_score(score)
            notes = []
            if name != text_value(name_raw):
                notes.append(f"姓名含多余空格，已清理为「{name}」")
            if completed:
                notes.append(
                    f"学号「{text_value(values[header_map['学号']])}」补全为 {student_id}"
                )
            if score_kind == "text_missing":
                notes.append(f"成绩为文本「{text_value(score)}」，不计入分数统计")
            elif score_kind == "out_of_range":
                notes.append(f"成绩 {score} 超出 0–100，疑似录入错误")
            elif score == 0:
                notes.append("成绩为 0 分，请确认是否缺考")

            records.append(
                {
                    "班级": f"{class_number}班",
                    "姓名": name,
                    "学号": student_id,
                    "成绩": score,
                    "备注": text_value(remark),
                    "数据校验": "；".join(notes),
                    "源文件": source.name,
                    "源行号": row_number,
                    "成绩类型": score_kind,
                }
            )
            merged_rows += 1

        workbook.close()
        file_seconds = time.perf_counter() - started_file
        cumulative_ai += file_seconds
        per_file_times.append(
            {
                "table": class_number,
                "fileSeconds": file_seconds,
                "cumulativeSeconds": cumulative_ai,
            }
        )
        class_rows.append(
            {
                "班级": f"{class_number}班",
                "源文件": source.name,
                "是否有表头": "有" if has_header else "无",
                "原始数据行数": raw_rows,
                "跳过空行": blank_rows,
                "合并行数": merged_rows,
            }
        )

    valid_scores = [row["成绩"] for row in records if row["成绩类型"] == "valid"]
    text_missing = sum(row["成绩类型"] == "text_missing" for row in records)
    out_of_range = sum(row["成绩类型"] == "out_of_range" for row in records)
    pass_count = sum(score >= 60 for score in valid_scores)
    totals = {
        "classes": len(class_rows),
        "records": len(records),
        "unique_student_ids": len({row["学号"] for row in records}),
        "valid_scores": len(valid_scores),
        "text_missing": text_missing,
        "out_of_range": out_of_range,
        "needs_review": text_missing + out_of_range + sum(score == 0 for score in valid_scores),
        "average": round(sum(valid_scores) / len(valid_scores), 1),
        "max_score": max(valid_scores),
        "min_score": min(valid_scores),
        "pass_rate": round(pass_count / len(valid_scores), 4),
    }

    result = {
        "source_dir": "任务样本",
        "records": records,
        "class_structure": class_rows,
        "totals": totals,
        "expected": EXPECTED,
        "checks": {key: totals[key] == value for key, value in EXPECTED.items()},
        "duplicate_student_ids": sorted(
            {
                row["学号"]
                for row in records
                if sum(other["学号"] == row["学号"] for other in records) > 1
            }
        ),
    }
    total_seconds = time.perf_counter() - started_all
    timing = {
        "measured_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "scope": "打开并规范化 10 张签到表，完成记录数、学号唯一性和成绩分类检查",
        "excludes": ["模型阅读需求与生成文字的耗时", "人工复核", "最终排版与图表渲染"],
        "per_file": per_file_times,
        "total_seconds": total_seconds,
    }

    with (args.output / "规范化总表.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(records[0].keys()))
        writer.writeheader()
        writer.writerows(records)
    with (args.output / "班级结构.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(class_rows[0].keys()))
        writer.writeheader()
        writer.writerows(class_rows)
    issue_rows = [
        {
            "班级": row["班级"],
            "姓名": row["姓名"],
            "学号": row["学号"],
            "数据校验": row["数据校验"],
            "源文件": row["源文件"],
            "源行号": row["源行号"],
        }
        for row in records
        if row["数据校验"]
    ]
    with (args.output / "问题清单.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(issue_rows[0].keys()))
        writer.writeheader()
        writer.writerows(issue_rows)
    (args.output / "校验结果.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (args.output / "AI脚本实测耗时.json").write_text(
        json.dumps(timing, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(json.dumps({"totals": totals, "checks": result["checks"], "timing_seconds": total_seconds},
                     ensure_ascii=False, indent=2))
    return 0 if all(result["checks"].values()) and not result["duplicate_student_ids"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
