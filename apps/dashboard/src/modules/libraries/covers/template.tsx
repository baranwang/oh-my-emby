import type { ReactElement } from "react";
export interface CoverRenderInput {
  readonly title: string;
  readonly posters: ReadonlyArray<string>;
  readonly background: string;
}
export const orderPosters = <T,>(posters: ReadonlyArray<T>): T[] => {
  if (!posters.length) throw new Error("No usable posters");
  const filled = Array.from({ length: 9 }, (_, i) => posters[i % posters.length]!);
  return [..."315426987"].map((n) => filled[Number(n) - 1]!);
};
export function createLibraryCoverTemplate(input: CoverRenderInput): ReactElement {
  const posters = orderPosters(input.posters),
    scale = 6;
  return (
    <div
      style={{
        display: "flex",
        position: "relative",
        width: 1920,
        height: 1080,
        overflow: "hidden",
        backgroundColor: input.background,
      }}
    >
      <div
        style={{
          display: "flex",
          position: "absolute",
          left: 0,
          top: 0,
          width: 1920,
          height: 1080,
          backgroundImage: "linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,0.2))",
        }}
      />
      <div
        style={{
          display: "flex",
          position: "absolute",
          left: 183 * scale,
          top: -55.5 * scale,
          width: 200 * scale,
          height: 328 * scale,
          transform: "rotate(15deg)",
          transformOrigin: "50% 50%",
        }}
      >
        {posters.map((src, i) => (
          <img
            key={i}
            src={src}
            width={64 * scale}
            height={96 * scale}
            style={{
              position: "absolute",
              left: Math.floor(i / 3) * 68 * scale,
              top: ((Math.floor(i / 3) === 1 ? 0 : 32) + (i % 3) * 100) * scale,
              width: 64 * scale,
              height: 96 * scale,
              objectFit: "cover",
              borderRadius: 4 * scale,
            }}
          />
        ))}
      </div>
    </div>
  );
}
