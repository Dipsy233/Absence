import { useDazeStore } from "./stores/useDazeStore";
import { useSessionSocket } from "./hooks/useSessionSocket";
import { Panel } from "./components/Panel";
import { SessionInfo } from "./components/SessionInfo/SessionInfo";
import { FileTree } from "./components/FileTree/FileTree";
import { Activity } from "./components/Activity/Activity";
import { Stage } from "./components/Stage/Stage";
import { Avatar } from "./components/Agent/Avatar";
import { PlanPaper } from "./components/Desk/PlanPaper";
import { Chat } from "./components/Chat/Chat";
import { ProjectPicker } from "./components/ProjectPicker/ProjectPicker";

export default function App() {
  const session = useDazeStore((s) => s.session);
  const status = useDazeStore((s) => s.agent.status);

  useSessionSocket(session?.id);

  if (!session) return <ProjectPicker />;

  return (
    <div className="grid h-full grid-cols-[300px_minmax(0,1fr)_360px] gap-2 p-2">
      {/* left column */}
      <div className="flex min-h-0 flex-col gap-2">
        <SessionInfo />
        <FileTree />
        <Activity />
      </div>

      {/* center: the stage */}
      <div className="flex min-h-0 flex-col gap-2">
        <Stage />
      </div>

      {/* right column */}
      <div className="flex min-h-0 flex-col gap-2">
        <Panel title="Agent" className="shrink-0" bodyClassName="h-[196px] p-2">
          <Avatar status={status} />
        </Panel>
        <PlanPaper />
        <Chat />
      </div>
    </div>
  );
}
