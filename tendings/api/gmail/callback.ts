import { gmailCallback } from "../../server/gmail.js";

export default function handler(request: any, response: any) {
  return gmailCallback(request, response);
}
