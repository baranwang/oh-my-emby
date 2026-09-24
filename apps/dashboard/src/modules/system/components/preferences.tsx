import { useTheme } from "@/components/theme-provider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { m } from "@/paraglide/messages.js"
import { getLocale, setLocale } from "@/paraglide/runtime.js"

export const Preferences = () => {
  const { theme, setTheme } = useTheme()

  return (
    <div className="divide-y">
      <div className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
        <Label htmlFor="preference-language">{m.language_label()}</Label>
        <Select value={getLocale()} onValueChange={(value) => {
          if (value === "en" || value === "zh-CN") void setLocale(value)
        }}>
          <SelectTrigger id="preference-language" aria-label={m.language_label()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="en">{m.language_english()}</SelectItem>
            <SelectItem value="zh-CN">{m.language_chinese()}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 py-3">
        <Label htmlFor="preference-theme">{m.theme_label()}</Label>
        <Select value={theme} onValueChange={(value) => {
          if (value === "system" || value === "light" || value === "dark") setTheme(value)
        }}>
          <SelectTrigger id="preference-theme" aria-label={m.theme_label()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">{m.theme_system()}</SelectItem>
            <SelectItem value="light">{m.theme_light()}</SelectItem>
            <SelectItem value="dark">{m.theme_dark()}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
