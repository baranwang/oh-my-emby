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

const languageLabels = {
  "zh-CN": m.metadata_language_zh_cn,
  "zh-TW": m.metadata_language_zh_tw,
  "zh-HK": m.metadata_language_zh_hk,
  "zh-SG": m.metadata_language_zh_sg,
  "es-ES": m.metadata_language_es_es,
  "en-US": m.metadata_language_en_us,
  "ar-SA": m.metadata_language_ar_sa,
  "ja-JP": m.metadata_language_ja_jp,
  "ko-KR": m.metadata_language_ko_kr,
  "ru-RU": m.metadata_language_ru_ru,
  "fr-FR": m.metadata_language_fr_fr,
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
    ...TMDB_LANGUAGE_CODES.map((code) => ({ value: code, label: languageLabels[code]() })),
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
