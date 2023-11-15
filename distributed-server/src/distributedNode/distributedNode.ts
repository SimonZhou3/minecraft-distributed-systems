import fastify from "fastify";
import { MinecraftServerAdaptor } from "../minecraftServerAdaptor/MinecraftServerAdaptor";
import { RSyncServer } from "../rsync/RSyncServer";
import { routes } from "./routes";
import { v4 as uuidv4 } from "uuid";
import * as fs from "fs";
import { DistributedNode, RAFTSave, RaftState } from "./node/distributedNodeInterface";
import axios, { AxiosError } from "axios";
import { clearInterval } from "timers";
import { RSyncClient } from "../rsync/RSyncClient";
import { HEARTBEAT_INTERVAL, HEARTBEAT_TIMER, RSYNC_INTERVAL } from "./node/timers";
import { RAFTconsensus } from "./RAFTconsensus";
const FILEPATH = "./src/distributedNode/node/save.json";
const ENV = "dev";
export class DistributedServerNode {
  // Network
  private mainPort: number;
  private rsyncPort: number;
  private minecraftPort: number;
  private address: string;

  // Main Server
  private mainServer: any;

  // RSync Server
  private rSyncServer: RSyncServer;

  // Internal data
  public isPrimaryNode: boolean;
  public inNetwork: boolean;
  public networkNodes: DistributedNode[];
  public uuid: string;
  public primaryNode: DistributedNode;
  public selfNode: DistributedNode;
  public alive: boolean;

  // Interal function data

  // Routine IDs
  private hearbeatId: any;
  private rSyncId: any;
  private heartbeatTimerId: any;

  // Rsync information
  private rSyncClient: RSyncClient;
  private rSyncTerm: number;

  // Raft Consensus
  private raftSave: RAFTSave;
  private RAFTConsensus: RAFTconsensus;

  constructor(
    address: string,
    mainPort: number,
    rsyncPort: number,
    minecraftPort: number,
    isPrimaryNode: boolean,
    inNetwork: boolean,
    networkNodes: DistributedNode[],
    uuid: string,
    rSyncTerm: number,
    raftSave: RAFTSave
  ) {
    this.mainPort = mainPort;
    this.rsyncPort = rsyncPort;
    this.minecraftPort = minecraftPort;
    this.address = address;
    this.isPrimaryNode = isPrimaryNode || false;
    this.inNetwork = inNetwork || false;
    this.uuid = uuid || null;
    this.rSyncTerm = rSyncTerm || 0;
    this.updateSelfNode();
    this.networkNodes = networkNodes || [this.selfNode];
    this.primaryNode = this.findPrimaryNode();
    this.alive = true;
    const baseRaftSave: RAFTSave = {
      currentTerm: 0,
      votedFor: null,
      state: RaftState.FOLLOWER,
    };
    this.raftSave = raftSave || baseRaftSave;
  }

  private findPrimaryNode() {
    for (const node of this.networkNodes) {
      if (node.isPrimary) {
        return node;
      }
    }
    return null;
  }

  public updateNodeList(nodeList: DistributedNode[]) {
    this.networkNodes = nodeList;
    this.primaryNode = this.findPrimaryNode();
  }

  public start(): void {
    this.initDistributedServer();
    this.initRoutines();
    if (this.isPrimaryNode) {
      // No need to init mc server
      if (ENV != "dev") {
        this.initMCServerApplication();
      }
      this.initRsyncServer();
    }
    this.initProcesses();
  }

  private initDistributedServer(): void {
    this.mainServer = fastify();
    // Init RAFT
    this.RAFTConsensus = new RAFTconsensus(
      this.raftSave.currentTerm,
      this.raftSave.votedFor,
      this.raftSave.state,
      this
    );
    // Define a route
    routes(this.mainServer, this);
    // Start the server on the specified port
    this.mainServer.listen({ port: this.mainPort }, (err, address) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      console.log(`Server listening at ${address}`);
    });
  }

  private initMCServerApplication(): void {
    MinecraftServerAdaptor.startMinecraftServer("../minecraft-server");
  }

  private initRsyncServer(): void {
    this.rSyncServer = new RSyncServer();
    this.rSyncServer.startServer(this.rsyncPort, "localhost");
  }

  private initProcesses() {
    process.on("beforeExit", async () => {
      await MinecraftServerAdaptor.shutdownMinecraftServer();
      await this.rSyncServer.stopServer();
    });

    process.on("SIGINT", async () => {
      await MinecraftServerAdaptor.shutdownMinecraftServer();
      await this.rSyncServer.stopServer();
      process.exit(1);
    });

    process.on("SIGTERM", async () => {
      await MinecraftServerAdaptor.shutdownMinecraftServer();
      await this.rSyncServer.stopServer();
      process.exit(1);
    });
  }

  private saveToFile() {
    try {
      const serializableNode = {
        mainPort: this.mainPort,
        rsyncPort: this.rsyncPort,
        minecraftPort: this.minecraftPort,
        address: this.address,
        isPrimaryNode: this.isPrimaryNode,
        inNetwork: this.inNetwork,
        networkNodes: this.networkNodes.map((node) => ({ ...node })),
        uuid: this.uuid,
        rSyncTerm: this.rSyncTerm,
        primaryNode: this.primaryNode,
        selfNode: { ...this.selfNode },
        alive: this.alive,
        raftSave: this.RAFTConsensus.saveFile(),
      };

      const serializedNode = JSON.stringify(serializableNode, null, 2);
      fs.writeFileSync(FILEPATH, serializedNode, "utf8");
      console.log("DistributedServerNode saved to file successfully.");
    } catch (err) {
      console.error("Error saving DistributedServerNode to file:", err);
    }
  }

  public getServerInformation() {
    console.log("getting server info");
    this.RAFTConsensus.startElection();
    const raftState = this.RAFTConsensus.saveFile();
    return {
      node: this.selfNode,
      network: this.networkNodes,
      primary: this.primaryNode,
      raftState: raftState,
    };
  }

  private updateSelfNode() {
    this.selfNode = {
      uuid: this.uuid,
      address: this.address,
      distributedPort: this.mainPort,
      rsyncPort: this.rsyncPort,
      minecraftPort: this.minecraftPort,
      alive: this.alive,
      isPrimary: this.isPrimaryNode,
      rSyncTerm: this.rSyncTerm,
    };
  }

  // Distributed Node functions

  // NETWORK JOINING AND LEAVING
  public createNetwork() {
    this.isPrimaryNode = true;
    this.inNetwork = true;
    this.uuid = uuidv4();
    this.rSyncTerm = 0;
    this.RAFTConsensus.state = RaftState.LEADER;
    this.updateSelfNode();
    this.networkNodes = [this.selfNode];
    this.primaryNode = this.findPrimaryNode();
    this.initRoutines();
    this.saveToFile();

    // this.initMCServerApplication();
    this.initRsyncServer();
  }
  public async requestNetwork({ address }) {
    const requestURL = `${address}/join-network`;
    this.uuid = uuidv4();
    this.updateSelfNode();
    try {
      const results = await axios.put(requestURL, this.selfNode);
      console.log("Join successful");
      // Update own network
      this.inNetwork = true;
      this.networkNodes = results.data.data;
      this.primaryNode = this.findPrimaryNode();

      // Rsync client update
      this.rSyncTerm = 0;
      this.rSyncClient = new RSyncClient({
        host: this.primaryNode.address,
        port: this.primaryNode.rsyncPort,
        username: "username",
        privateKey: require("fs").readFileSync("./src/rsync/ssh/minecraftServer.pem"),
      });
      this.RAFTConsensus = new RAFTconsensus(
        this.raftSave.currentTerm,
        this.raftSave.votedFor,
        this.raftSave.state,
        this
      );

      this.initRoutines();
      this.saveToFile();
    } catch (error) {
      // Handle the error
      console.error("Error joining network:", error);
    }
  }
  public acceptJoinNetwork(node: DistributedNode) {
    this.networkNodes.push(node);
    return this.networkNodes;
  }
  public async requestLeaveNetwork() {
    // If it is primary, remove itself from all other nodes in the server
    if (this.isPrimaryNode) {
      await this.acceptLeaveNetwork(this.selfNode);
    } else {
      // If not, tell primary to remove itself from all other nodes in the server
      const requestURL = `http://${this.primaryNode.address}:${this.primaryNode.distributedPort}/leave-network`;
      try {
        const results = await axios.put(requestURL, this.selfNode);
        console.log("Leave Successful");
      } catch (error) {
        // Handle the error
        console.error("Error joining network:", error.message);
      }
    }

    this.primaryNode = null;
    this.isPrimaryNode = false;
    this.networkNodes = [];
    this.uuid = null;
    this.inNetwork = false;
    this.initRoutines();
    this.saveToFile();
  }
  public async acceptLeaveNetwork(node: DistributedNode) {
    this.removeNetworkNode(node.uuid);
    await this.propagateNetworkNodeList();
  }
  public removeNetworkNode(uuid: string) {
    const indexToRemove = this.networkNodes.findIndex((node) => node.uuid === uuid);
    if (indexToRemove !== -1) {
      this.networkNodes.splice(indexToRemove, 1);
      console.log(`Network node with UUID ${uuid} removed successfully.`);
    } else {
      console.warn(`Network node with UUID ${uuid} not found.`);
    }
  }
  private sendPutRequest(node: DistributedNode): Promise<void> {
    const url = `http://${node.address}:${node.distributedPort}/update-network`;
    return axios
      .put(url, this.networkNodes)
      .then(() => console.log(`PUT request to ${url} successful.`))
      .catch((error: AxiosError) => {
        console.error(`Error in PUT request to ${url}:`, error.message);
        //Test if server is dead
      });
  }
  public async propagateNetworkNodeList(): Promise<void> {
    const requestPromises = this.networkNodes.map((node) => {
      // Dont send to itself
      if (node.uuid != this.uuid) {
        this.sendPutRequest(node);
      }
    });

    try {
      await Promise.all(requestPromises);
      console.log("All network list propogation completed successfully.");
    } catch (error) {
      console.error("At least one PUT request failed:", error.message);
    }
  }

  // RSYNC
  public syncWorlds() {
    if (ENV == "dev") {
      this.rSyncClient.run(`rsync -avz --delete ../minecraft-server/world ./test/worlds/${this.uuid}`);
      this.rSyncClient.run(`rsync -avz --delete ../minecraft-server/world_nether ./test/worlds/${this.uuid}`);
      this.rSyncClient.run(`rsync -avz --delete ../minecraft-server/world_the_end ./test/worlds/${this.uuid}`);
    } else {
      this.rSyncClient.run(`rsync -avz --delete ../minecraft-server/world ../minecraft-server`);
      this.rSyncClient.run(`rsync -avz --delete ../minecraft-server/world_nether ../minecraft-server`);
      this.rSyncClient.run(`rsync -avz --delete ../minecraft-server/world_end ../minecraft-server`);
    }
  }

  // NETWORK ROUTINES

  public initRoutines() {
    this.resetRoutines();
    this.initHeartbeatRoutine();
    //this.initReplicationRoutine();
    console.log(`Complete Routine Setup for ${this.uuid}`);
  }

  public resetRoutines() {
    this.rSyncId && clearInterval(this.rSyncId);
    this.hearbeatId && clearInterval(this.hearbeatId);
  }

  // Only primary send to other
  public initReplicationRoutine() {
    if (this.isPrimaryNode) {
      this.rSyncId = setInterval(async () => {
        this.rSyncTerm = this.rSyncTerm + 1;
        console.debug(this.rSyncTerm);
        await this.propagateRsync();
      }, RSYNC_INTERVAL);
    }
  }
  private sendRSyncRequest(node: DistributedNode): Promise<void> {
    const url = `http://${node.address}:${node.distributedPort}/rSync`;
    return axios
      .put(url, { data: this.rSyncTerm })
      .then(() => console.log(`PUT request to ${url} successful.`))
      .catch((error: AxiosError) => {
        console.error(`Error in PUT request to ${url}:`, error.message);
        //Test if server is dead
      });
  }
  public async propagateRsync(): Promise<void> {
    const requestPromises = this.networkNodes.map((node) => {
      // Dont send to itself
      if (node.uuid != this.uuid) {
        this.sendRSyncRequest(node);
      }
    });

    try {
      await Promise.all(requestPromises);
      console.log("All Rsync requests completed successfully.");
    } catch (error) {
      console.error("At least one PUT request failed:", error.message);
    }
  }

  public initHeartbeatRoutine() {
    if (this.inNetwork) {
      if (this.isPrimaryNode) {
        this.hearbeatId = setInterval(async () => {
          //Send hearbeat to all servers
          await this.propagateHeartbeat();
        }, HEARTBEAT_INTERVAL);
      } else {
        // Set up the timer to check for heartbeats every 5 seconds
        this.heartbeatTimerId = setInterval(this.handlePrimaryFailure, HEARTBEAT_TIMER); // Check every 5 seconds
      }
    }
  }

  private sendHeartbeatRequest(node: DistributedNode): Promise<void> {
    const url = `http://${node.address}:${node.distributedPort}/heartbeat`;
    return axios
      .get(url)
      .then(() => console.log(`GET request to ${url} successful.`))
      .catch((error: AxiosError) => {
        console.error(`Error in GET request to ${url}:`, error.message);
        //If server dead
        node.alive = false;
      });
  }

  public async propagateHeartbeat(): Promise<void> {
    const requestPromises = this.networkNodes.map((node) => {
      // Dont send to itself
      if (node.uuid != this.uuid) {
        this.sendHeartbeatRequest(node);
      }
    });

    try {
      await Promise.all(requestPromises);
      console.log("All Heartbeat requests completed successfully.");
    } catch (error) {
      console.error("At least one PUT request failed:", error.message);
    }
  }

  public handlePrimaryFailure() {
    console.log("Primary failure detected");
    if (this.primaryNode) {
      this.primaryNode.alive = false;
    }

    this.RAFTConsensus.startElection();
  }

  public resetHeartbeatTimer() {
    try {
      clearInterval(this.heartbeatTimerId);
      this.heartbeatTimerId = setInterval(() => {
        this.handlePrimaryFailure();
      }, HEARTBEAT_TIMER);
    } catch (error) {
      console.error("An error occurred while resetting the heartbeat timer:", error);
    }
  }
}

export function loadFromFile(): DistributedServerNode | null {
  try {
    const data = fs.readFileSync(FILEPATH, "utf8");
    const parsedData = JSON.parse(data);

    // Assuming DistributedServerNode is your class
    const loadedNode = new DistributedServerNode(
      parsedData.address,
      parsedData.mainPort,
      parsedData.rsyncPort,
      parsedData.minecraftPort,
      parsedData.isPrimaryNode,
      parsedData.inNetwork,
      parsedData.networkNodes,
      parsedData.uuid,
      parsedData.rSyncTerm,
      parsedData.raftSave
    );

    console.log("DistributedServerNode loaded from file successfully.");
    return loadedNode;
  } catch (err) {
    console.error("Error reading/parsing DistributedServerNode from file:", err);
    return null;
  }
}
