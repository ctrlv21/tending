import { gmailStatus } from "../../server/gmail.js";

export default function handler(request: any, response: any) {
  return gmailStatus(request, response);
}
