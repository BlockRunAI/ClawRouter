import { describe, expect, it } from "vitest";
import { inferToolRequirement } from "./tool-intent.js";

describe("inferToolRequirement", () => {
  it("does not confuse available tools with a tool requirement", () => {
    expect(inferToolRequirement("Which option best explains the observation?\nA. One\nB. Two\nC. Three\nD. Four")).toBe(false);
    expect(inferToolRequirement("What is 17 times 9?")).toBe(false);
  });

  it("recognizes explicit tool, repository, web, and stateful actions", () => {
    expect(inferToolRequirement("Use the lookup_order tool for order B-42.")).toBe(true);
    expect(inferToolRequirement("Patch the repository and run the tests.")).toBe(true);
    expect(inferToolRequirement("Calculate the average and save it in a file called result.txt.")).toBe(true);
    expect(inferToolRequirement("Search the web for today's weather in Shanghai.")).toBe(true);
    expect(inferToolRequirement("Cancel my flight booking and refund the ticket.")).toBe(true);
    expect(inferToolRequirement("修改仓库里的文件，然后运行测试。" )).toBe(true);
  });

  it("honors the OpenAI tool_choice contract", () => {
    expect(inferToolRequirement("Retrieve the account details.", undefined, "required")).toBe(true);
    expect(
      inferToolRequirement("Retrieve the account details.", undefined, {
        type: "function",
        function: { name: "get_account" },
      }),
    ).toBe(true);
    expect(inferToolRequirement("What is 17 times 9?", undefined, "auto")).toBe(false);
  });
});
