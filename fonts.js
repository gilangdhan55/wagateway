import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// __dirname replacement di ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const loadFont = (file) => {
  return fs.readFileSync(path.join(__dirname, "fonts", file)).toString("base64");
};

export const fonts = {
  condensedBold: loadFont("GT-Walsheim-Condensed-Bold.otf"),
  medium: loadFont("GT-Walsheim-Medium.otf"),
  regular: loadFont("GT-Walsheim-Regular.otf"),
  light: loadFont("GT-Walsheim-Light.otf"),
};