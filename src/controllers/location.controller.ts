import { Request, Response } from "express";
import {
  GetAllLocationsService,
  GetLocationService,
  CreateLocationService,
  UpdateLocationService,
  DeleteLocationService,
} from "@/services/location";

export class LocationController {
  // Get All Locations
  public getAll = async (_req: Request, res: Response) => {
    const result = await GetAllLocationsService();
    return res.status(result.code).json(result);
  };

  // Get Location by ID
  public getById = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await GetLocationService(id);
    return res.status(result.code).json(result);
  };

  // Create Location
  public create = async (req: Request, res: Response) => {
    const result = await CreateLocationService(req.body);
    return res.status(result.code).json(result);
  };

  // Update Location
  public update = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await UpdateLocationService(id, req.body);
    return res.status(result.code).json(result);
  };

  // Delete Location
  public delete = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = await DeleteLocationService(id);
    return res.status(result.code).json(result);
  };
}
