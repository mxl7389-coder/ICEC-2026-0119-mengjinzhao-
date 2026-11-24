# -*- coding: utf-8 -*-
"""课题04 出图脚本：读 raw_data/queue_log.csv，算指标并画图。
用法：python 出图.py
依赖：pandas、matplotlib（pip install pandas matplotlib）
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


def main():
    os.makedirs(OUT, exist_ok=True)
    df = pd.read_csv(CSV, encoding="utf-8-sig")
    df = df.rename(columns={
        "时点(min)": "t", "队列长度(人)": "L", "本时段到达人数(人)": "arr",
        "窗口数": "win", "单人服务时长(s)": "srv"})
    for c in ["t", "L", "arr", "win", "srv"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["t", "L", "arr", "win", "srv"])

    if df.empty:
        print("表格里还没有有效数据：请先在 raw_data/queue_log.csv 里填入 15 组观测值。")
        print("必须填的列：队列长度、到达人数、窗口数、单人服务时长。")
        sys.exit(1)

    df["lam"] = df["arr"] / 2.0                       # 人/min
    df["mu"] = df["win"] * 60.0 / df["srv"]           # 人/min
    df["rho"] = df["lam"] / df["mu"]
    df["W"] = df["L"] / df["lam"].replace(0, pd.NA) * 60.0   # 秒
    df["cum_arr"] = df["arr"].cumsum()
    df["cum_out"] = (df["mu"] * 2).cumsum()

    print(df[["t", "L", "arr", "lam", "mu", "rho", "W"]].to_string(index=False))
    print()
    print("平均到达率 λ = %.2f 人/min，平均服务率 μ = %.2f 人/min" % (df["lam"].mean(), df["mu"].mean()))
    print("峰值利用率 ρmax = %.2f（出现在第 %d 分钟）" % (df["rho"].max(), df.loc[df["rho"].idxmax(), "t"]))
    print("队列长度：%.0f → %.0f 人" % (df["L"].iloc[0], df["L"].iloc[-1]))
    print("平均等待 W ≈ %.0f 秒" % df["W"].mean())

    # 图1 队列长度时序
    fig, ax = plt.subplots(figsize=(9, 4.2))
    ax.plot(df["t"], df["L"], marker="o", color="#2F6B4F", lw=2)
    ax.fill_between(df["t"], df["L"], color="#2F6B4F", alpha=0.12)
    ax.set_xlabel("观测时点（分钟）")
    ax.set_ylabel("队列长度（人）")
    ax.set_title("图1 队列长度随时间变化")
    ax.grid(alpha=0.3, ls=":")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "fig1_queue.png"), dpi=200)
    plt.close(fig)

    # 图2 到达率 vs 服务率
    fig, ax = plt.subplots(figsize=(9, 4.2))
    w = 0.7
    ax.bar(df["t"], df["lam"], width=w, label="到达率 λ", color="#B4513B", alpha=0.85)
    ax.plot(df["t"], df["mu"], marker="s", color="#2F6B4F", lw=2, label="服务率 μ")
    ax.set_xlabel("观测时点（分钟）")
    ax.set_ylabel("人 / 分钟")
    ax.set_title("图2 到达率与服务率对比（柱高于线即开始排队）")
    ax.legend()
    ax.grid(alpha=0.3, ls=":", axis="y")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "fig2_lambda_mu.png"), dpi=200)
    plt.close(fig)

    # 图3 累计到达 vs 累计离开
    fig, ax = plt.subplots(figsize=(9, 4.2))
    ax.plot(df["t"], df["cum_arr"], marker="o", lw=2, color="#B4513B", label="累计到达")
    ax.plot(df["t"], df["cum_out"], marker="s", lw=2, color="#2F6B4F", label="累计离开（理论）")
    ax.fill_between(df["t"], df["cum_out"], df["cum_arr"], color="#B4513B", alpha=0.15)
    ax.set_xlabel("观测时点（分钟）")
    ax.set_ylabel("累计人数")
    ax.set_title("图3 累计到达与累计离开（阴影为积压）")
    ax.legend()
    ax.grid(alpha=0.3, ls=":")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "fig3_cumulative.png"), dpi=200)
    plt.close(fig)

    print("\n已输出：figs/fig1_queue.png、fig2_lambda_mu.png、fig3_cumulative.png")


if __name__ == "__main__":
    main()
