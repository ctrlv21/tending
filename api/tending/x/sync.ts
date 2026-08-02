import { xSync } from "../../../tendings/server/x.js";
export default function handler(request: any, response: any) { return xSync(request, response); }
