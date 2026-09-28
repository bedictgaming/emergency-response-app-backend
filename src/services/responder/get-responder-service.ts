import { ResponderRepository } from "@/repositories/responder.repository";

const responderRepository = new ResponderRepository();

export const GetResponderService = async (id: string) => {
  try {
    const responder = await responderRepository.findById(id);

    if (!responder) {
      return { code: 404, status: "error", message: "Responder not found" };
    }

    return {
      code: 200,
      status: "success",
      data: { responder },
    };
  } catch (error) {
    console.error("GetResponderService Error", error);
    return { code: 500, status: "error", message: "Failed to fetch responder" };
  }
};
