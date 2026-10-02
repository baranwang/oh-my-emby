import { TMDB_LANGUAGE_CODES } from "@oh-my-emby/contracts";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { m } from "@/paraglide/messages.js";

const nativeLanguageName = (code: string) => {
  const locale = new Intl.Locale(code).maximize();
  const language = locale.language === "zh" ? `zh-${locale.script}` : locale.language;
  const name = new Intl.DisplayNames([code], { type: "language" }).of(language) ?? code;
  if (locale.language !== "zh" || locale.region === "CN" || !locale.region) return name;
  const region =
    new Intl.DisplayNames([code], { type: "region" }).of(locale.region) ?? locale.region;
  return `${name}（${region}）`;
};

export const MetadataLanguageSelect = ({
  id,
  label,
  value,
  artwork = false,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly artwork?: boolean;
  readonly onChange: (value: string) => void;
}) => {
  const options: { value: string; label: string }[] = [
    ...(artwork
      ? [
          { value: "metadata", label: m.metadata_language_metadata() },
          { value: "original", label: m.metadata_language_original() },
        ]
      : [{ value: "system", label: m.metadata_language_system() }]),
    ...TMDB_LANGUAGE_CODES.map((code) => ({ value: code, label: nativeLanguageName(code) })),
  ];
  if (!options.some((option) => option.value === value)) options.push({ value, label: value });
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger id={id} aria-label={label} className="w-full">
          <SelectValue>{options.find((option) => option.value === value)?.label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};
