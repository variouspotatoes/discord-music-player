import Discord, { Interaction, GuildMember, Snowflake } from "discord.js";
import {
  AudioPlayerStatus,
  AudioResource,
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { REST } from "@discordjs/rest";
import { ApplicationCommandOptionType, Routes } from "discord-api-types/v9";
import { Track } from "./music/track";
import { MusicSubscription } from "./music/subscription";
import ytdl from "ytdl-core";
import yts from "yt-search";
import SpotifyWebApi from "spotify-web-api-node";

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { token, clientId, guildId = null } = require("../auth.json");

const client = new Discord.Client({
  intents: ["GUILD_VOICE_STATES", "GUILD_MESSAGES", "GUILDS"],
});

client.on("ready", () => console.log("Ready!"));

// This contains the setup code for creating slash commands in a guild.
const commands = [
  {
    name: "play",
    description: "Plays a song",
    options: [
      {
        name: "song",
        type: ApplicationCommandOptionType.String,
        description: "The URL of the song to play",
        required: true,
      },
    ],
  },
  {
    name: "skip",
    description: "Skip to the next song in the queue",
  },
  {
    name: "queue",
    description: "See the music queue",
  },
  {
    name: "pause",
    description: "Pauses the song that is currently playing",
  },
  {
    name: "resume",
    description: "Resume playback of the current song",
  },
  {
    name: "leave",
    description: "Leave the voice channel",
  },
  {
    name: "minecraft",
    description: "Start the Minecraft server",
},
{
    name: "serverstatus",
    description: "Check if server is up",
}
];

const rest = new REST({ version: "9" }).setToken(token);

(async () => {
  try {
    console.log("Started refreshing application (/) commands.");

    /**
     * If guildId is specified, immediately refresh (/) commands for that guild.
     */
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands,
      });
    }

    await rest.put(Routes.applicationCommands(clientId), { body: commands });

    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error(error);
  }
})();

/**
 * Maps guild IDs to music subscriptions, which exist if the bot has an active VoiceConnection to the guild.
 */
const subscriptions = new Map<Snowflake, MusicSubscription>();

// Handles slash command interactions
client.on("interactionCreate", async (interaction: Interaction) => {
  if (!interaction.isCommand() || !interaction.guildId) return;
  let subscription = subscriptions.get(interaction.guildId);

  if (interaction.commandName === "play") {
    await interaction.deferReply();
    // Extract the video URL from the command
    //song parameter is from command
    let songinfo = interaction.options.get("song")!.value! as string;

    // If a connection to the guild doesn't already exist and the user is in a voice channel, join that channel
    // and create a subscription.
    if (!subscription) {
      if (
        interaction.member instanceof GuildMember &&
        interaction.member.voice.channel
      ) {
        const channel = interaction.member.voice.channel;
        subscription = new MusicSubscription(
          joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator as any,
          })
        );
        subscription.voiceConnection.on("error", console.warn);
        subscriptions.set(interaction.guildId, subscription);
      }
    }

    // If there is no subscription, tell the user they need to join a channel.
    if (!subscription) {
      await interaction.followUp(
        "Join a voice channel and then try that again!"
      );
      return;
    }

    // Make sure the connection is ready before processing the user's request
    try {
      await entersState(
        subscription.voiceConnection,
        VoiceConnectionStatus.Ready,
        20e3
      );
    } catch (error) {
      console.warn(error);
      await interaction.followUp(
        "Failed to join voice channel within 20 seconds, please try again later!"
      );
      return;
    }

    try {
      // Attempt to create a Track from the user's video URL
      //this should check if url or not. if not, search for song instead, and then u can try making the track
      if (!ytdl.validateURL(songinfo)) {
        const vids = await yts(songinfo);
        if (!vids.videos.length) throw Error;
        songinfo = vids.videos[0].url
      }

      const track = await Track.from(songinfo, {
        onStart() {
          interaction
            .followUp({ content: "Now playing!", ephemeral: true })
            .catch(console.warn);
        },
        onFinish() {
          interaction
            .followUp({ content: "Now finished!", ephemeral: true })
            .catch(console.warn);
        },
        onError(error) {
          console.warn(error);
          interaction
            .followUp({ content: `Error: ${error.message}`, ephemeral: true })
            .catch(console.warn);
        },
      });
      // Enqueue the track and reply a success message to the user
      subscription.enqueue(track);
      await interaction.followUp(`Enqueued **${track.title}**`);

    } catch (error) {
      console.warn(error);
      await interaction.followUp(
        "Failed to play track, please try again later!"
      );
    }
  } else if (interaction.commandName === "skip") {
    if (subscription) {
      // Calling .stop() on an AudioPlayer causes it to transition into the Idle state. Because of a state transition
      // listener defined in music/subscription.ts, transitions into the Idle state mean the next track from the queue
      // will be loaded and played.
      subscription.audioPlayer.stop();
      await interaction.reply("Skipped song!");
    } else {
      await interaction.reply("Not playing in this server!");
    }
  } else if (interaction.commandName === "queue") {
    // Print out the current queue, including up to the next 5 tracks to be played.
    if (subscription) {
      const current =
        subscription.audioPlayer.state.status === AudioPlayerStatus.Idle
          ? `Nothing is currently playing!`
          : `Playing **${
              (subscription.audioPlayer.state.resource as AudioResource<Track>)
                .metadata.title
            }**`;

      const queue = subscription.queue
        .slice(0, 5)
        .map((track, index) => `${index + 1}) ${track.title}`)
        .join("\n");

      await interaction.reply(`${current}\n\n${queue}`);
    } else {
      await interaction.reply("Not playing in this server!");
    }
  } else if (interaction.commandName === "pause") {
    if (subscription) {
      subscription.audioPlayer.pause();
      await interaction.reply({ content: `Paused!`, ephemeral: true });
    } else {
      await interaction.reply("Not playing in this server!");
    }
  } else if (interaction.commandName === "resume") {
    if (subscription) {
      subscription.audioPlayer.unpause();
      await interaction.reply({ content: `Unpaused!`, ephemeral: true });
    } else {
      await interaction.reply("Not playing in this server!");
    }
  } else if (interaction.commandName === "leave") {
    if (subscription) {
      subscription.voiceConnection.destroy();
      subscriptions.delete(interaction.guildId);
      await interaction.reply({ content: `Left channel!`, ephemeral: true });
    } else {
      await interaction.reply("Not playing in this server!");
    }
  } else if (interaction.commandName === "minecraft") {
      await interaction.reply("mc");
  } else if (interaction.commandName === "serverstatus" ) {
      await interaction.reply("status");
  } else {
    await interaction.reply("Unknown command");
  }
});

client.on("error", console.warn);

void client.login(token);
