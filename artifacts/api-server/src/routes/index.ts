import { Router, type IRouter } from "express";
import authRouter from "./auth";
import customerRouter from "./customer";
import storeRouter from "./store";
import adminRouter from "./admin";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(customerRouter);
router.use(storeRouter);
router.use(adminRouter);

export default router;
