import { gmailSync } from "../../server/gmail.js";

export default function handler(request: any, response: any) {
  return gmailSync(request, response);
}
