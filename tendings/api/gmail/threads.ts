import { gmailThreads } from "../../server/gmail.js";

export default function handler(request: any, response: any) {
  return gmailThreads(request, response);
}
