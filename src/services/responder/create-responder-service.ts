import { ResponderRepository } from "@/repositories/responder.repository";
import { CreateResponderInput } from "@/schema/responder/create-responder.schema";

const responderRepository = new ResponderRepository();

export const CreateResponderService = async (data: CreateResponderInput) => {
  try {
    // 1. Verify user exists
    const user = await responderRepository.findUserById(data.userId);
    if (!user) {
      return {
        code: 404,
        status: "error",
        message: "User not found. Please provide a valid userId.",
      };
    }
    if (user.role !== "RESPONDER") {
      return { code: 409, status: "error", message: "Set the user role to RESPONDER before creating a responder profile" };
    }

    // 2. Check if user already has a linked responder record (1-to-1 relationship)
    const existingResponder = await responderRepository.findByUserId(data.userId);
    if (existingResponder) {
      return {
        code: 409,
        status: "error",
        message: `User is already assigned to a responder profile (ID: ${existingResponder.responderId})`,
      };
    }

    // 3. Verify unit exists
    const unit = await responderRepository.findUnitById(data.unitId);
    if (!unit) {
      return {
        code: 404,
        status: "error",
        message: "Unit not found. Please provide a valid unitId.",
      };
    }

    const responder = await responderRepository.create(data);

    return {
      code: 201,
      status: "success",
      message: "Responder profile created successfully",
      data: { responder },
    };
  } catch (error) {
    console.error("CreateResponderService Error", error);
    return { code: 500, status: "error", message: "Failed to create responder profile" };
  }
};
