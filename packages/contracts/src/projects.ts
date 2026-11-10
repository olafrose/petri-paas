import { z } from "zod";
import { dnsLabel } from "./common.ts";

export const visibility = z.enum(["public", "private"]);

/** A preview image: where to load it, and its size. */
export const imageRef = z
	.object({
		url: z.string().meta({
			description: "Path of the image; changes when a new one is uploaded",
		}),
		width: z.int().positive(),
		height: z.int().positive(),
	})
	.meta({ id: "ImageRef" });

export type ImageRef = z.infer<typeof imageRef>;

export const project = z
	.object({
		id: z.uuid(),
		number: z.int().positive().meta({
			description: "Experiment number (EXP-007): sequential, never changes",
		}),
		name: z.string(),
		slug: dnsLabel,
		description: z.string(),
		notes: z.string().meta({ description: "Personal lab notes" }),
		visibility,
		featuredDeploymentId: z
			.uuid()
			.nullable()
			.meta({ description: "Deployment shown in the public gallery" }),
		image: imageRef
			.nullable()
			.meta({ description: "Preview image for the gallery" }),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso.datetime(),
	})
	.meta({ id: "Project" });

export type Project = z.infer<typeof project>;

const name = z.string().trim().min(1, "Give it a name").max(100);
const description = z.string().max(500);
const notes = z.string().max(50_000);

export const createProjectBody = z
	.object({
		name,
		slug: dnsLabel.optional().meta({
			description:
				"Stable identifier. Derived from the name when omitted; cannot be changed later.",
		}),
		description: description.optional(),
		notes: notes.optional(),
		visibility: visibility.optional(),
	})
	.strict()
	.meta({ id: "CreateProject" });

export type CreateProjectBody = z.infer<typeof createProjectBody>;

export const updateProjectBody = z
	.object({
		name: name.optional(),
		description: description.optional(),
		notes: notes.optional(),
		visibility: visibility.optional(),
		featuredDeploymentId: z.uuid().nullable().optional().meta({
			description: "Must be a deployment of this project, or null to clear",
		}),
	})
	.strict()
	.meta({ id: "UpdateProject" });

export type UpdateProjectBody = z.infer<typeof updateProjectBody>;

export const projectList = z
	.object({ items: z.array(project) })
	.meta({ id: "ProjectList" });

export type ProjectList = z.infer<typeof projectList>;
