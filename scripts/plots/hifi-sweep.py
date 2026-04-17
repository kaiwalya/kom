"""Generate the plots used in src/content/blog/hifi-sweep.md.

Usage: python3 scripts/plots/hifi-sweep.py
Outputs to public/blog/hifi-sweep/*.svg
"""
from pathlib import Path
import numpy as np
import matplotlib.pyplot as plt

OUT = Path(__file__).resolve().parents[2] / "public" / "blog" / "hifi-sweep"
OUT.mkdir(parents=True, exist_ok=True)

# Parameters chosen for plot readability, not audibility.
F_MIN = 1.0
F_MAX = 5.0
T_DURATION = 1.0

t = np.linspace(0, T_DURATION, 1000)

def f_intended(t):
    return F_MIN + (F_MAX - F_MIN) * (t / T_DURATION)

def f_heard_wrong(t):
    # d/dt [f(t) * t] = f(t) + t * f'(t)
    f_prime = (F_MAX - F_MIN) / T_DURATION
    return f_intended(t) + t * f_prime

def phase_wrong(t):
    return f_intended(t) * t

def phase_correct(t):
    return F_MIN * t + (F_MAX - F_MIN) * t**2 / (2 * T_DURATION)

def sample_wrong(t):
    return np.sin(2 * np.pi * phase_wrong(t))

def sample_correct(t):
    return np.sin(2 * np.pi * phase_correct(t))

def style(ax, xlabel, ylabel, title=None):
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    if title:
        ax.set_title(title)
    ax.grid(True, alpha=0.3)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)

def save(fig, name):
    path = OUT / f"{name}.svg"
    fig.savefig(path, bbox_inches="tight", transparent=True)
    plt.close(fig)
    print(f"wrote {path}")

plt.rcParams.update({
    "font.size": 11,
    "font.family": "sans-serif",
    "axes.labelsize": 11,
    "axes.titlesize": 12,
    "figure.figsize": (6.5, 3.5),
})

# Plot 1: intended linear ramp f(t)
fig, ax = plt.subplots()
ax.plot(t, f_intended(t), color="#2b6cb0", linewidth=2, label=r"$f(t)$")
ax.axhline(F_MIN, color="#999", linestyle="--", linewidth=0.8)
ax.axhline(F_MAX, color="#999", linestyle="--", linewidth=0.8)
ax.annotate(r"$f_\mathrm{min}$", xy=(0, F_MIN), xytext=(-0.05, F_MIN), ha="right", va="center")
ax.annotate(r"$f_\mathrm{max}$", xy=(T_DURATION, F_MAX), xytext=(T_DURATION + 0.02, F_MAX), ha="left", va="center")
style(ax, "time $t$", "frequency (Hz)")
ax.legend(loc="lower right", frameon=False)
save(fig, "01-intended-ramp")

# Plot 2: intended f(t) vs heard f_heard(t)
fig, ax = plt.subplots()
ax.plot(t, f_intended(t), color="#2b6cb0", linewidth=2, label=r"intended $f(t)$")
ax.plot(t, f_heard_wrong(t), color="#c53030", linewidth=2, label=r"heard $f(t) + t\,f'(t)$")
ax.axhline(F_MAX, color="#999", linestyle="--", linewidth=0.8)
ax.annotate(r"$f_\mathrm{max}$", xy=(T_DURATION, F_MAX), xytext=(T_DURATION + 0.02, F_MAX), ha="left", va="center")
ax.annotate(r"$2f_\mathrm{max} - f_\mathrm{min}$",
            xy=(T_DURATION, f_heard_wrong(T_DURATION)),
            xytext=(T_DURATION + 0.02, f_heard_wrong(T_DURATION)),
            ha="left", va="center")
style(ax, "time $t$", "frequency (Hz)")
ax.legend(loc="upper left", frameon=False)
save(fig, "02-intended-vs-heard")

# Plot 3: phase — wrong product vs correct integral
fig, ax = plt.subplots()
ax.plot(t, phase_wrong(t), color="#c53030", linewidth=2, label=r"wrong: $f(t)\cdot t$")
ax.plot(t, phase_correct(t), color="#2b6cb0", linewidth=2, label=r"correct: $\int_0^t f(\tau)\,d\tau$")
style(ax, "time $t$", "phase / $2\\pi$ (cycles)")
ax.legend(loc="upper left", frameon=False)
save(fig, "03-phase")

# Plot 4: actual waveform — wrong vs correct (compact)
fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(6.5, 4.2), sharex=True)
ax1.plot(t, sample_wrong(t), color="#c53030", linewidth=1)
ax1.set_title("wrong: sweep outruns its schedule")
ax1.set_ylabel("amplitude")
ax1.grid(True, alpha=0.3)
ax1.spines["top"].set_visible(False)
ax1.spines["right"].set_visible(False)

ax2.plot(t, sample_correct(t), color="#2b6cb0", linewidth=1)
ax2.set_title("correct: linear chirp")
ax2.set_xlabel("time $t$")
ax2.set_ylabel("amplitude")
ax2.grid(True, alpha=0.3)
ax2.spines["top"].set_visible(False)
ax2.spines["right"].set_visible(False)

fig.tight_layout()
save(fig, "04-waveforms")
