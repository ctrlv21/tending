import { gmailStart } from "../../server/gmail.js";

export default function handler(request: any, response: any) {
  return gmailStart(request, response);
}
