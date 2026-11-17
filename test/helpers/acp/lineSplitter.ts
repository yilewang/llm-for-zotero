/**
 * Turns an arbitrary stream of text chunks into complete lines.
 *
 * Pipes deliver chunks with no regard for message boundaries, so a JSON-RPC
 * message can arrive split across chunks or several can arrive in one.
 */
export function createLineSplitter(
  onLine: (line: string) => void,
): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      onLine(line);
      newline = buffer.indexOf("\n");
    }
  };
}
