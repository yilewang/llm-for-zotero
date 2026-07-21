export type HeaderClearLayoutMeasurement = {
  headerRight: number;
  leftContentRight: number;
  actionsLeft: number;
  actionsRight: number;
  minimumGap?: number;
  tolerance?: number;
};

export function shouldCompactHeaderClearButton({
  headerRight,
  leftContentRight,
  actionsLeft,
  actionsRight,
  minimumGap = 4,
  tolerance = 0.5,
}: HeaderClearLayoutMeasurement): boolean {
  return (
    leftContentRight + minimumGap > actionsLeft + tolerance ||
    actionsRight > headerRight + tolerance
  );
}
