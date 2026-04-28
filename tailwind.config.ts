import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{js,jsx,ts,tsx}"],
  safelist: [
    "bg-brand-50", "bg-brand-100", "bg-brand-200", "bg-brand-300", "bg-brand-400",
    "bg-brand-500", "bg-brand-600", "bg-brand-700", "bg-brand-800",
    "text-brand-200", "text-brand-300", "text-brand-400", "text-brand-500",
    "text-brand-600", "text-brand-700",
    "border-brand-200", "border-brand-300", "border-brand-600",
    "hover:bg-brand-600", "hover:bg-brand-700",
    "hover:border-brand-300", "hover:text-brand-700",
    "ring-brand-500", "ring-brand-500/40", "focus:ring-brand-500/40", "focus:border-brand-500",
    "from-brand-500", "to-brand-400", "from-brand-800", "via-brand-700", "to-brand-600",
    "shadow-glow", "shadow-warm-sm", "shadow-warm-md",
    "hover:shadow-warm-sm", "hover:shadow-warm-md",
    "animate-pulse-soft", "animate-fade-in", "animate-slide-up", "animate-check-pop",
    "bg-cream", "bg-cream-dark", "bg-cream-dark/50",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0fdf4",
          100: "#dcfce7",
          200: "#bbf7d0",
          300: "#86efac",
          400: "#4ade80",
          500: "#22c55e",
          600: "#16a34a",
          700: "#15803d",
          800: "#166534",
          900: "#14532d",
          950: "#052e16",
        },
        cream: "#FEFCF3",
        "cream-dark": "#FBF7ED",
        surface: "#FFFFFF",
        accent: "#F4A261",
        "accent-dark": "#E76F51",
      },
      fontFamily: {
        display: ['"DM Sans"', "system-ui", "sans-serif"],
        body: ['"Inter"', "system-ui", "sans-serif"],
      },
      boxShadow: {
        "warm-xs": "0 1px 2px rgba(28, 25, 23, 0.04)",
        "warm-sm": "0 1px 3px rgba(28, 25, 23, 0.06), 0 1px 2px rgba(28, 25, 23, 0.04)",
        "warm-md": "0 4px 12px rgba(28, 25, 23, 0.07)",
        "warm-lg": "0 12px 40px rgba(28, 25, 23, 0.1)",
        "warm-xl": "0 24px 60px rgba(28, 25, 23, 0.14)",
        glow: "0 0 0 3px rgba(34, 197, 94, 0.2)",
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.25rem",
        "4xl": "1.5rem",
      },
      keyframes: {
        fadeIn: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        slideUp: {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        scaleIn: {
          from: { opacity: "0", transform: "scale(0.95)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        pulseSoft: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.6" },
        },
        fillBar: {
          from: { width: "0%" },
          to: { width: "var(--fill-width)" },
        },
        checkPop: {
          "0%": { transform: "scale(0)", opacity: "0" },
          "60%": { transform: "scale(1.2)", opacity: "1" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
      },
      animation: {
        "fade-in": "fadeIn 0.3s ease-out forwards",
        "slide-up": "slideUp 0.4s ease-out forwards",
        "scale-in": "scaleIn 0.3s ease-out forwards",
        "pulse-soft": "pulseSoft 2s ease-in-out infinite",
        "fill-bar": "fillBar 0.6s ease-out forwards",
        "check-pop": "checkPop 0.3s ease-out forwards",
      },
    },
  },
  plugins: [],
} satisfies Config;
