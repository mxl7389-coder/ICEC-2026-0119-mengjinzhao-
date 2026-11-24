# -*- coding: utf-8 -*-
"""课题10 出图脚本：读 raw_data/time_audit.csv，查错 + 画 4 张图。
用法：python 出图.py
依赖：pandas、matplotlib
"""
import os
import sys
import pandas as pd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
plt.rcParams["axes.unicode_minus"] = False

HERE = os.path.dirname(os.path.abspath(__file__))
CSV = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "raw_data", "示例_模拟数据_非实测.csv")
if not os.path.isabs(CSV):
    CSV = os.path.join(HERE, CSV)
OUT = os.path.join(HERE, "figs")
TYPES = ["学习", "创作", "事务", "娱乐", "社交"]
COLORS = {"学习": "#2F6B4F", "创作": "#B4513B", "事务": "#8A7A55",
          "娱乐": "#C9B48E", "社交": "#7FA38C"}


def hm2min(s):
    try:
        h, m = str(s).strip().split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return None


def main():
    os.makedirs(OUT, exist_ok=True)
    df = pd.read_csv(CSV, encoding="utf-8-sig")
    df = df.dropna(subset=["日期", "任务名称", "类型", "实际时长(min)"])
    if df.empty:
        print("表格里还没有有效数据：请先在 raw_data/time_audit.csv 里录入任务。")
        print("至少要填：日期、任务名称、类型、实际时长。")
        sys.exit(1)

    df["实际时长(min)"] = pd.to_numeric(df["实际时长(min)"], errors="coerce")
    df["专注时长(min)"] = pd.to_numeric(df["专注时长(min)"], errors="coerce")
    df["计划时长(min)"] = pd.to_numeric(df["计划时长(min)"], errors="coerce")
    df["中断次数"] = pd.to_numeric(df["中断次数"], errors="coerce").fillna(0)

    bad = []
    for i, r in df.iterrows():
        s, e = hm2min(r.get("开始时间")), hm2min(r.get("结束时间"))
        if r["类型"] not in TYPES:
            bad.append((i, "R4 类型不在枚举内"))
        if pd.notna(r["专注时长(min)"]) and r["专注时长(min)"] > r["实际时长(min)"]:
            bad.append((i, "R3 专注时长大于实际时长"))
        if s is not None and e is not None and abs((e - s) - r["实际时长(min)"]) > 2:
            bad.append((i, "R2 实际时长与起止时间不符"))
    if bad:
        print("以下记录未通过校验，已在统计中剔除：")
        for i, msg in bad:
            print("  第 %s 条：%s" % (df.loc[i, "序号"], msg))
        df = df.drop(index=[i for i, _ in bad]).reset_index(drop=True)
        if df.empty:
            print("剔除后没有可用数据。")
            sys.exit(1)

    df["日期"] = df["日期"].astype(str)
    total = df["实际时长(min)"].sum()
    print("有效记录 %d 条，总时长 %.1f 小时" % (len(df), total / 60))
    for t in TYPES:
        sub = df[df["类型"] == t]
        if len(sub):
            print("  %s：%d 条，%.1f 小时，占 %.1f%%" %
                  (t, len(sub), sub["实际时长(min)"].sum() / 60,
                   sub["实际时长(min)"].sum() / total * 100))

    # 图1 每日各类型堆积
    pivot = df.pivot_table(index="日期", columns="类型", values="实际时长(min)",
                           aggfunc="sum").reindex(columns=TYPES).fillna(0)
    fig, ax = plt.subplots(figsize=(10, 4.6))
    bottom = None
    for t in TYPES:
        b = bottom if bottom is not None else [0] * len(pivot)
        ax.bar(pivot.index, pivot[t], bottom=b, label=t, color=COLORS[t])
        bottom = [b[i] + pivot[t].iloc[i] for i in range(len(pivot))]
    ax.set_ylabel("时长（分钟）")
    ax.set_title("图1 每日各类型耗时堆积")
    ax.legend(ncol=5, fontsize=9)
    ax.grid(alpha=0.3, ls=":", axis="y")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "fig1_daily_stack.png"), dpi=200)
    plt.close(fig)

    # 图2 中断原因帕累托
    if df["中断次数"].sum() > 0:
        reasons = (df[df["中断原因"].notna()]
                   .groupby("中断原因")["中断次数"].sum().sort_values(ascending=False))
        if len(reasons):
            fig, ax = plt.subplots(figsize=(9, 4.4))
            ax.bar(reasons.index, reasons.values, color="#B4513B", alpha=0.85)
            ax.set_ylabel("中断次数")
            ax2 = ax.twinx()
            ax2.plot(reasons.index, reasons.values.cumsum() / reasons.values.sum() * 100,
                     marker="o", color="#2F6B4F", lw=2)
            ax2.set_ylabel("累计占比 %")
            ax2.set_ylim(0, 105)
            ax.set_title("图2 中断原因帕累托")
            plt.setp(ax.get_xticklabels(), rotation=20, ha="right")
            fig.tight_layout()
            fig.savefig(os.path.join(OUT, "fig2_interrupt_pareto.png"), dpi=200)
            plt.close(fig)

    # 图3 任务时长 vs 专注率
    if df["专注时长(min)"].notna().any():
        d = df.dropna(subset=["专注时长(min)"])
        rate = d["专注时长(min)"] / d["实际时长(min)"] * 100
        fig, ax = plt.subplots(figsize=(8.5, 4.4))
        ax.scatter(d["实际时长(min)"], rate, s=46, color="#2F6B4F", alpha=0.8, edgecolors="white")
        ax.axhline(rate.mean(), ls="--", color="#B4513B", lw=1.4,
                   label="平均专注率 %.0f%%" % rate.mean())
        ax.set_xlabel("任务实际时长（分钟）")
        ax.set_ylabel("专注率 %")
        ax.set_title("图3 任务时长与专注率")
        ax.legend()
        ax.grid(alpha=0.3, ls=":")
        fig.tight_layout()
        fig.savefig(os.path.join(OUT, "fig3_focus_scatter.png"), dpi=200)
        plt.close(fig)

    # 图4 计划 vs 实际
    d = df.dropna(subset=["计划时长(min)"])
    if len(d):
        fig, ax = plt.subplots(figsize=(6.4, 5.6))
        ax.scatter(d["计划时长(min)"], d["实际时长(min)"], s=46, color="#8A7A55", alpha=0.85)
        lim = max(d["计划时长(min)"].max(), d["实际时长(min)"].max()) * 1.1
        ax.plot([0, lim], [0, lim], ls="--", color="#B4513B", lw=1.4, label="45° 线（计划=实际）")
        ax.set_xlabel("计划时长（分钟）")
        ax.set_ylabel("实际时长（分钟）")
        ax.set_title("图4 计划与实际对比")
        ax.legend()
        ax.grid(alpha=0.3, ls=":")
        fig.tight_layout()
        fig.savefig(os.path.join(OUT, "fig4_plan_vs_actual.png"), dpi=200)
        plt.close(fig)

    print("\n已输出 figs/ 目录下的 PNG 图。")


if __name__ == "__main__":
    main()
