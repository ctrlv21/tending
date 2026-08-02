import { priorities } from "../../tendings/server/priorities.js";
export default function handler(request: any, response: any) { return priorities(request, response); }
