import type { ReactElement } from "react";
export interface CoverRenderInput {
  readonly title: string;
  readonly posters: ReadonlyArray<string>;
  readonly background: string;
}
export const orderPosters = (posters: ReadonlyArray<string>): string[] => {
  if (!posters.length) throw new Error("No usable posters");
  const filled = Array.from({ length: 9 }, (_, i) => posters[i % posters.length]!);
  return [..."315426987"].map((n) => filled[Number(n) - 1]!);
};
export function createLibraryCoverTemplate(input: CoverRenderInput): ReactElement {
  const posters = orderPosters(input.posters);
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
          left: -240,
          top: -378,
          width: 2400,
          height: 1836,
          transform: "rotate(-10deg)",
          transformOrigin: "50% 50%",
        }}
      >
        {Array.from({ length: 18 }, (_, i) => (
          <img
            key={i}
            src={posters[i % posters.length]}
            width={388}
            height={582}
            style={{
              position: "absolute",
              left: (i % 6) * 400,
              top: Math.floor(i / 6) * 612 - (i % 2) * 96,
              width: 388,
              height: 582,
              objectFit: "cover",
              borderRadius: 12,
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          position: "absolute",
          left: 0,
          top: 0,
          width: 1920,
          height: 1080,
          backgroundColor: "rgba(0,0,0,0.58)",
          backgroundImage:
            "linear-gradient(to bottom, rgba(0,0,0,0.15), rgba(0,0,0,0), rgba(0,0,0,0.25))",
        }}
      />
    </div>
  );
}
